import { DocumentNode, DirectiveNode } from 'graphql';
import { invariant } from 'ts-invariant';
import {
  removeDirectivesFromDocument,
  checkDocument,
  RemoveNodeConfig,
} from 'apollo-utilities';

export const hasPersistDirective = (doc: DocumentNode) => {
  let hasDirective = false;
  let onSync = '';
  const offlineRemoveConfig: RemoveNodeConfig<DirectiveNode> = {
    remove: true,
    test: directive => {
      const willRemove = directive.name.value === 'offline';
      if (willRemove) {
        hasDirective = true;
        if (
          directive.arguments &&
          !directive.arguments.some((arg: any) => {
            const existsDirective = arg.name.value === 'onSync';
            if (existsDirective && arg.value) {
              onSync = arg.value.value;
            }
            return existsDirective;
          })
        ) {
          invariant.warn(
            'Removing an @offline directive even though it does not have onSync. ' +
              'You may want to use the key parameter to specify a store key.',
          );
        }
      }
      return willRemove;
    },
  };

  const newDoc = removeDirectivesFromDocument(
    [offlineRemoveConfig],
    checkDocument(doc),
  );

  if (hasDirective && !onSync) {
    console.error('Error @offline requiere onSync');
  }

  return {
    onSync,
    hasDirective,
    newDoc,
  };
};
