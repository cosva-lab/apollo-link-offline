import {
  ApolloLink,
  Observable,
  Operation,
  NextLink,
} from 'apollo-link';
import uuidv4 from 'uuid/v4';
import { print as printer } from 'graphql/language/printer';
import gql from 'graphql-tag';
import ApolloClient, { ApolloError } from 'apollo-client';
import { NormalizedCacheObject } from 'apollo-cache-inmemory';
import debounce from 'lodash/debounce';
import unset from 'lodash/unset';
import set from 'lodash/set';
import { ServerError } from 'apollo-link-http-common';
import {
  SequentialTaskQueue,
  extractFiles,
  b64toBlob,
  hasPersistDirective,
} from './utils';
import {
  PersistentStorage,
  FilesSaved,
  Props,
  OfflineAction,
} from './types';

const syncStatusQuery = gql`
  query syncStatus {
    mutations
    inflight
  }
`;

const OFFLINE_LINK_FILES = '@offlineLink/files';

interface Attempt {
  mutation: string;
  variables: any;
  optimisticResponse: any;
  files?: string;
}

export class OfflineLink extends ApolloLink {
  private storage: PersistentStorage<any>;

  private storeKey: string;

  private sequential: boolean;

  private actions: { [key: string]: OfflineAction };

  private retryOnServerError: boolean;

  private queue = new Map<string, Attempt>();

  private queueFiles: Map<string, FilesSaved[]> = new Map();

  private delayedSync: ReturnType<typeof debounce>;

  private client!: ApolloClient<NormalizedCacheObject>;

  // Retry mutations in parallel
  private queueMutate = new SequentialTaskQueue();

  /**
   * storage
   * Provider that will persist the mutation queue. This can be AsyncStorage, window.localStorage, etc.
   *
   * retryInterval
   * Milliseconds between attempts to retry failed mutations. Defaults to 5000 seconds.
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
    const {
      optimisticResponse,
      queueItemKey,
    } = operation.getContext();

    const { variables } = operation;
    const { query } = operation;
    const result = hasPersistDirective(query);
    const { onSync } = result;

    if (result.hasDirective && result.newDoc)
      operation.query = result.newDoc;

    if (!optimisticResponse) {
      // If the mutation does not have an optimistic response then we don't defer it
      return forward(operation);
    }

    return new Observable(observer => {
      let attemptId: Promise<string> | undefined = undefined;
      if (!queueItemKey) {
        attemptId = this.addAttempt({
          mutation: printer(query),
          variables,
          optimisticResponse,
        });
      }
      const catchError = (e: any) => console.log(e);
      const removeAttempt = (id: string) => {
        this.removeAttempt(id)
          .then(() => {
            this.delayedSync();
          })
          .catch(catchError);
      };
      const getAttemptAndRemove = () => {
        attemptId && attemptId.then(removeAttempt).catch(catchError);
      };

      const subscription = forward(operation).subscribe({
        next: result => {
          // Mutation was successful so we remove it from the queue since we don't need to retry it later
          if (!queueItemKey) getAttemptAndRemove();
          else removeAttempt(queueItemKey);
          if (!(result.errors || []).length) {
            if (onSync && queueItemKey) {
              const action = this.actions[onSync];
              if (typeof action === 'function')
                action(operation.getContext() as any, result);
            }
          }
          observer.next(result);
        },
        error: err => {
          switch (err.statusCode) {
            case 400:
              if (!queueItemKey) getAttemptAndRemove();
              else removeAttempt(queueItemKey);
              observer.error(err);
              break;
            default:
              // Mutation failed so we try again after a certain amount of time.
              if (!queueItemKey)
                attemptId &&
                  attemptId
                    .then(() => this.saveQueueAndDelayedSync())
                    .catch(catchError);
              else this.delayedSync();
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
   *
   * Obtains the queue of mutations that must be sent to the server.
   * These are kept in a Map to preserve the order of the mutations in the queue.
   *
   * @return {Promise<Map<string, Attempt>>}
   * @memberof OfflineLink
   */
  public getQueue(): Promise<Map<string, Attempt>> {
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
  public async saveQueue() {
    this.updateStatus(false);
    return this.storage.setItem(
      this.storeKey,
      JSON.stringify(Array.from(this.queue)),
    );
  }

  /**
   * Persist the queue so mutations can be retried at a later point in time.
   */
  public async saveQueueFiles() {
    this.updateStatus(false);
    return this.storage.setItem(
      OFFLINE_LINK_FILES,
      JSON.stringify(Array.from(this.queueFiles)),
    );
  }

  saveQueueAndDelayedSync() {
    return Promise.all([
      this.saveQueueFiles(),
      this.saveQueue(),
    ]).then(() => {
      this.delayedSync();
    });
  }

  public getQueueFiles(): Promise<Map<string, FilesSaved[]>> {
    return this.storage
      .getItem(OFFLINE_LINK_FILES)
      .then(
        (stored: string) => new Map(JSON.parse(stored)) || new Map(),
      );
  }

  /**
   *
   * Updates a SyncStatus object in the Apollo Cache so that the queue status can be obtained and dynamically updated.
   *
   * @param {boolean} inflight
   * @memberof OfflineLink
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
   *
   * @param {{
   *     mutation: string,
   *     variables: any,
   *     optimisticResponse: any
   *   }} attempt
   * @return {string}
   * @memberof OfflineLink
   */
  async addAttempt(attempt: Attempt): Promise<string> {
    const attemptId = uuidv4();
    const { files, clone } = extractFiles(attempt);
    if (files.size) {
      // We give the mutation attempt a random id so that it is easy to remove when needed (in sync loop)
      return new Promise<FilesSaved[]>(resolve => {
        const promises: Promise<any>[] = [];
        files.forEach(async (value, key) => {
          promises.push(
            new Promise(resolve => {
              const fr = new FileReader();
              fr.onload = () => {
                return resolve({
                  key,
                  name: value.name,
                  result: fr.result,
                });
              }; // CHANGE to whatever function you want which would eventually call resolve
              fr.readAsDataURL(value);
            }),
          );
        });
        Promise.all(promises)
          .then(res => {
            resolve(res);
          })
          .catch(() => {});
      })
        .then(res => {
          set(clone, 'files', attemptId);
          this.queue.set(attemptId, clone);
          this.queueFiles.set(attemptId, res);
          return attemptId;
        })
        .catch(e => {
          throw e;
        });
    }
    this.queue.set(attemptId, attempt);
    return attemptId;
  }

  /**
   *
   * Remove a mutation attempt from the queue.
   * @param {string} attemptId
   * @return {Promise<void>}
   * @memberof OfflineLink
   */
  async removeAttempt(attemptId: string) {
    if (this.queueFiles.has(attemptId)) {
      this.queueFiles.delete(attemptId);
      await this.saveQueueFiles();
    }
    this.queue.delete(attemptId);
    return this.saveQueue();
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

    // Retry the mutations in the queue, the successful ones are removed from the queue
    const attempts = Array.from(this.queue);
    if (this.sequential) {
      // Retry the mutations in the order in which they were originally executed
      attempts.every(([attemptId, attempt]) => {
        this.client
          .mutate<Attempt, any>({
            mutation: gql(attempt.mutation),
            variables: attempt.variables,
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
      attempts.forEach(async ([attemptId, attempt]) => {
        const keyFiles = attempt.files;
        if (keyFiles) {
          const { files } = extractFiles(attempt);
          if (!files.size) {
            const mapFiles = this.queueFiles.get(keyFiles);
            if (mapFiles) {
              mapFiles.forEach(({ key, result, name }) => {
                b64toBlob(result, name);
                set(attempt, key.split('.'), b64toBlob(result, name));
              });
            }
          }
        }
        this.queueMutate.push(() => {
          return new Promise((resolve, reject) => {
            const {
              variables,
              optimisticResponse,
              mutation,
            } = attempt;
            this.client
              .mutate({
                variables,
                optimisticResponse,
                context: { queueItemKey: attemptId },
                mutation: gql(mutation),
                errorPolicy: 'all',
              })
              // Mutation was successfully executed so we remove it from the queue
              .then(res => {
                unset(attempt, 'files');
                resolve(res);
              })
              .catch(async err => {
                // There are GraphQL errors, which means the server processed the request so we can remove the mutation from the queue
                this.queueMutate.cancel();
                if (err instanceof ApolloError && err.networkError) {
                  const { result } = err.networkError as ServerError;
                  if (
                    result &&
                    result.errors &&
                    result.errors.length
                  ) {
                    if (keyFiles) this.queueFiles.delete(keyFiles);
                    this.queue.delete(attemptId);
                  }
                }
                // Remaining mutations in the queue are persisted
                await this.saveQueue();
                reject(err);
              })
              .catch(a => {
                console.log(a);
              });
          });
        });
      });
      this.queueMutate
        .wait()
        .then(() => {
          if (this.queue.size > 0) {
            // If there are any mutations left in the queue, we retry them at a later point in time
            this.delayedSync();
          }
        })
        .catch(() => {});
    }
  }

  /**
   *
   * Configure the link to use Apollo Client and immediately try to sync the queue (if there's anything there).
   *
   * @param {ApolloClient<NormalizedCacheObject>} client
   * @return {Promise<void>}
   * @memberof OfflineLink
   */
  public async setup(client: ApolloClient<NormalizedCacheObject>) {
    this.client = client;
    this.queue = await this.getQueue();
    this.queueFiles = await this.getQueueFiles();

    return this.sync();
  }
}

export default OfflineLink;
