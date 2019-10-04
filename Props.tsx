import { InMemoryCache } from 'apollo-cache-inmemory';
import { FetchResult } from 'apollo-link';
export interface Props {
  storage: PersistentStorage<any>;
  retryInterval?: 5000;
  sequential?: false;
  storeKey?: '@offlineLink';
  retryOnServerError?: false;
  actions?: { [key: string]: OfflineAction };
}

export interface PersistentStorage<T> {
  getItem: (key: string) => Promise<T> | T;
  setItem: (key: string, data: T) => Promise<void> | void;
  removeItem: (key: string) => Promise<void> | void;
}

export interface FilesSaved {
  key: string;
  result: string;
  name: string;
}

export interface ActionResponse<TData = object> {
  cache: InMemoryCache;
  getCacheKey: (obj: {
    __typename: string;
    id: string | number;
  }) => any;
  forceFetch: boolean;
  headers: object;
  optimisticResponse: TData;
  queueItemKey: string;
  response: Response;
}

export declare type OfflineAction<TData = any> = (
  constext: ActionResponse<TData>,
  result: FetchResult<TData>,
) => void;
