import { visit, BREAK, ASTNode } from 'graphql';
export const hasPersistDirective = (doc: ASTNode) => {
  let hasDirective = false;
  visit(doc, {
    Directive: ({ name: { value: name } }) => {
      debugger;
      if (name === 'persist') {
        hasDirective = true;
        return BREAK;
      }
    },
  });
  return hasDirective;
};
