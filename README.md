# @cosva-lab/apollo-link-offline

An Apollo Link to queue mutations when offline or network errors exist.

Biggest different between this module and other offline modules available is that this module assumes the worst. It assumes the request will not reach the server and queues all mutations, responds with optimistic response and removes the mutation from the queue when the server responds success.

Reason for this assumption is twofold:

Speed, since all mutations have optimistic response, the UI feels much snappier (like a local app)
In cases where the the network is NOT offline but really slow (think 2G in a third world country) and the request doesn't reach the server anyway, our queue retries until the server responds with success.

## Usage

Import and initialize this link in just two lines:

```js
import { ApolloLink } from 'apollo-link';
import { createHttpLink, OfflineAction } from '@cosva-lab/apollo-link-offline';
import localforage from 'localforage';


const syncUserCreated: OfflineAction<Pick<
  Mutation,
  'createUser'
>> = ({ cache, optimisticResponse }, newData) => {
  // Read this https://www.apollographql.com/docs/react/caching/cache-interaction/#writequery-and-writefragment
};

const offlineLink = new OfflineLink({
  storage: localforage,
  actions: { syncUserCreated },
});

const link = ApolloLink.from([
  offlineLink,
  ...
]);


export const client = new ApolloClient({
  link,
  cache,
  ...
});
```

### @offline annotation to mutations

apollo-link-offline needs to receive the onSync entry in the @offline annotation to
know what function to call when the data is synchronized

Example: @offline (onSync: syncUserCreated)

```js
import gql from 'graphql-tag';

export const CREATE_USER = gql`
  mutation($name: String!) @offline(onSync: syncUserCreated) {
    ...
  }
`;
```
