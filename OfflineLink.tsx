import {
  ApolloLink,
  Observable,
  Operation,
  NextLink,
} from 'apollo-link';
import debounce from 'lodash/debounce';
import uuidv4 from 'uuid/v4';
import { print as printer } from 'graphql/language/printer';
import gql from 'graphql-tag';
import ApolloClient from 'apollo-client';
import { NormalizedCacheObject } from 'apollo-cache-inmemory';
import { Cancelable, set, unset } from 'lodash';
import {
  SequentialTaskQueue,
  extractFiles,
  b64toBlob,
  hasPersistDirective,
} from './utils';

const syncStatusQuery = gql`
  query syncStatus {
    mutations
    inflight
  }
`;

interface PersistentStorage<T> {
  getItem: (key: string) => Promise<T> | T;
  setItem: (key: string, data: T) => Promise<void> | void;
  removeItem: (key: string) => Promise<void> | void;
}

declare type FilesSaved = {
  key: string;
  result: string;
  name: string;
};

interface Props {
  storage: PersistentStorage<any>;
  retryInterval?: 5000;
  sequential?: false;
  storeKey?: '@offlineLink';
  retryOnServerError?: false;
  actions?: any;
}

const OFFLINE_LINK_FILES = '@offlineLink/files';

export default class OfflineLink extends ApolloLink {
  private storage: PersistentStorage<any>;
  private storeKey: string;
  private sequential: boolean;
  private actions: any;
  private retryOnServerError: boolean;
  private queue = new Map();
  private delayedSync: (() => void) & Cancelable;
  private client!: ApolloClient<NormalizedCacheObject>;
  /**
   * storage
   * Provider that will persist the mutation queue. This can be AsyncStorage, window.localStorage, et.
   *
   * retryInterval
   * Milliseconds between attempts to retry failed mutations. Defaults to 30,000 milliseconds.
   *
   * sequential
   * Indicates if the attempts should be retried in order. Defaults to false which retries all failed mutations in parallel.
   *
   * retryOnServerError
   * Indicates if mutations should be reattempted if there are server side errors, useful to retry mutations on session expiration. Defaults to false.
   */
  constructor({
    storage,
    retryInterval = 5000,
    sequential = false,
    storeKey = '@offlineLink',
    retryOnServerError = false,
    actions = {},
  }: Props) {
    super();

    if (!storage) {
      throw new Error(
        'Storage is required, it can be window.localStorage, AsyncStorage, etc.',
      );
    }

    this.storage = storage;
    this.storeKey = storeKey;
    this.sequential = sequential;
    this.actions = actions;
    this.retryOnServerError = retryOnServerError;
    this.delayedSync = debounce(this.sync, retryInterval);
  }

  public request(
    operation: Operation,
    forward: NextLink,
  ): Observable<any> {
    const { optimisticResponse } = operation.getContext();

    const { query, variables } = operation;
    hasPersistDirective(query);

    if (!optimisticResponse) {
      // If the mutation does not have an optimistic response then we don't defer it
      return forward(operation);
    }

    return new Observable(observer => {
      const attemptId = this.add({
        mutation: printer(query),
        variables,
        optimisticResponse,
      });

      const subscription = forward(operation).subscribe({
        next: result => {
          // Mutation was successful so we remove it from the queue since we don't need to retry it later
          attemptId.then(id => {
            this.remove(id);
          });
          if (!(result.errors || []).length) {
            const { onSync } = optimisticResponse;
            if (onSync) {
              const action = this.actions[onSync];
              if (typeof action === 'function') {
                action(operation.getContext(), result);
              }
            }
            observer.next(result);
          } else {
            observer.error(result);
          }
        },
        error: async err => {
          switch (err.statusCode) {
            case 400:
              attemptId.then(id => {
                this.remove(id);
              });
              observer.error(err);
              break;
            default:
              // Mutation failed so we try again after a certain amount of time.
              this.delayedSync();
              // Resolve the mutation with the optimistic response so the UI can be updated
              observer.next({
                data: optimisticResponse,
                dataPresent: true,
                errors: [],
              });

              // Say we're all done so the UI is re-rendered.
              observer.complete();
              break;
          }
        },
        complete: () => observer.complete(),
      });

      return (): void => {
        subscription.unsubscribe();
      };
    });
  }

  /**
   * Obtains the queue of mutations that must be sent to the server.
   * These are kept in a Map to preserve the order of the mutations in the queue.
   */
  public getQueue(): Promise<Map<unknown, unknown>> {
    return this.storage
      .getItem(this.storeKey)
      .then(
        (stored: string) => new Map(JSON.parse(stored)) || new Map(),
      )
      .catch(
        () =>
          // Most likely happens the first time a mutation attempt is being persisted.
          new Map(),
      );
  }

  /**
   * Persist the queue so mutations can be retried at a later point in time.
   */
  public saveQueueFiles(key: string, files: FilesSaved[]): void {
    const mapfiles = new Map();
    mapfiles.set(key, files);
    this.storage.setItem(
      OFFLINE_LINK_FILES,
      JSON.stringify(Array.from(mapfiles)),
    );
    this.updateStatus(false);
  }

  public getQueueFiles(): Promise<Map<string, FilesSaved[]>> {
    return this.storage
      .getItem(OFFLINE_LINK_FILES)
      .then(
        (stored: string) => new Map(JSON.parse(stored)) || new Map(),
      );
  }
  /**
   * Persist the queue so mutations can be retried at a later point in time.
   */
  public saveQueue(): void {
    this.storage.setItem(
      this.storeKey,
      JSON.stringify(Array.from(this.queue)),
    );
    this.updateStatus(false);
  }

  /**
   * Updates a SyncStatus object in the Apollo Cache so that the queue status can be obtained and dynamically updated.
   */
  public updateStatus(inflight: boolean) {
    this.client.writeQuery({
      query: syncStatusQuery,
      data: {
        __typename: 'SyncStatus',
        mutations: this.queue.size,
        inflight,
      },
    });
  }

  /**
   * Add a mutation attempt to the queue so that it can be retried at a later point in time.
   */
  async add(item: {
    mutation: string;
    variables: any;
    optimisticResponse: any;
  }): Promise<string> {
    const attemptId = uuidv4();
    const { files } = extractFiles(item);
    if (!files.size) {
      return new Promise(resolve => {
        resolve(attemptId);
      });
    }
    return new Promise((resolve, _reject) => {
      new Promise<FilesSaved[]>(resolveFiles => {
        const promises: Promise<any>[] = [];
        files.forEach(async (value, key) => {
          promises.push(
            new Promise(r => {
              const fr = new FileReader();
              fr.onload = () => {
                return r({
                  key,
                  name: value.name,
                  result: fr.result,
                });
              }; // CHANGE to whatever function you want which would eventually call resolve
              fr.readAsDataURL(value);
            }),
          );
        });
        Promise.all(promises).then(res => {
          resolveFiles(res);
        });
      }).then(res => {
        set(item, 'files', true);
        this.queue.set(attemptId, item);
        this.saveQueueFiles(attemptId, res);
        this.saveQueue();
        resolve(attemptId);
      });
    });
    // We give the mutation attempt a random id so that it is easy to remove when needed (in sync loop)
  }

  /**
   * Remove a mutation attempt from the queue.
   */
  remove(attemptId: string): void {
    this.queue.delete(attemptId);

    this.saveQueue();
  }

  /**
   * Takes the mutations in the queue and try to send them to the server again.
   */
  public async sync(): Promise<void> {
    if (this.queue.size < 1) {
      // There's nothing in the queue to sync, no reason to continue.
      return;
    }

    // Update the status to be "in progress"
    this.updateStatus(true);

    const queueFiles: Map<
      string,
      FilesSaved[]
    > = await this.getQueueFiles();
    // Retry the mutations in the queue, the successful ones are removed from the queue
    if (this.sequential) {
      // Retry the mutations in the order in which they were originally executed
      const attempts = Array.from(this.queue);

      attempts.every(([attemptId, attempt]: any) => {
        // eslint-disable-next-line no-await-in-loop
        this.client
          .mutate({
            ...attempt,
            optimisticResponse: undefined,
          })
          .then(() => {
            // Mutation was successfully executed so we remove it from the queue
            this.queue.delete(attemptId);

            return true;
          })
          .catch(err => {
            if (
              this.retryOnServerError === false &&
              (err.networkError || {}).response
            ) {
              // There are GraphQL errors, which means the server processed the request so we can remove the mutation from the queue

              this.queue.delete(attemptId);

              return true;
            }
            // There was a network error so we have to retry the mutation

            return false;
          });
        // The last mutation failed so we don't attempt any more
        return true;
      });
    } else {
      // Retry mutations in parallel
      const queue = new SequentialTaskQueue();

      Array.from(this.queue).forEach(async ([attemptId, attempt]) => {
        if (attempt.files) {
          const { files } = extractFiles(attempt);
          if (!files.size) {
            const mapFiles = queueFiles.get(attemptId);
            if (mapFiles) {
              mapFiles.forEach(({ key, result, name }) => {
                b64toBlob(result, name);
                set(attempt, key.split('.'), b64toBlob(result, name));
              });
            }
          }
          console.log(attempt);
          unset(attempt, 'files');
        }
        queue.push(() =>
          this.client
            .mutate({
              ...attempt,
              mutation: gql(attempt.mutation),
            })
            // Mutation was successfully executed so we remove it from the queue
            .then(() => {
              this.queue.delete(attemptId);
              // Remaining mutations in the queue are persisted
              this.saveQueue();
            })
            .catch(err => {
              // There are GraphQL errors, which means the server processed the request so we can remove the mutation from the queue
              if (
                this.retryOnServerError === false &&
                ((err.networkError || {}).response ||
                  (err.networkError || {}).errors)
              ) {
                this.queue.delete(attemptId);
              }
              // Remaining mutations in the queue are persisted
              this.saveQueue();
            }),
        );
      });
      queue.wait().then(res => {
        console.log(res);
      });
    }

    if (this.queue.size > 0) {
      // If there are any mutations left in the queue, we retry them at a later point in time
      this.delayedSync();
    }
  }

  /**
   * Configure the link to use Apollo Client and immediately try to sync the queue (if there's anything there).
   */
  public async setup(client: ApolloClient<NormalizedCacheObject>) {
    this.client = client;
    this.queue = await this.getQueue();

    return this.sync();
  }
}
