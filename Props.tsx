export interface Props {
  storage: PersistentStorage<any>;
  retryInterval?: 5000;
  sequential?: false;
  storeKey?: '@offlineLink';
  retryOnServerError?: false;
  actions?: any;
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
