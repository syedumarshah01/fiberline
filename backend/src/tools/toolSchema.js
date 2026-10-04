const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    type: 'function',
    function: Object.freeze({
      name: 'lookupDocs',
      description: 'Answer a question using Fiberline project documentation. Use this for app behavior, setup, feature, and configuration questions; do not guess undocumented defaults.',
      parameters: Object.freeze({
        type: 'object',
        properties: Object.freeze({
          query: Object.freeze({
            type: 'string',
            minLength: 1,
            maxLength: 1000,
            description: 'A focused question about documented Fiberline behavior or setup.',
          }),
        }),
        required: Object.freeze(['query']),
        additionalProperties: false,
      }),
    }),
  }),
]);

function getToolSchema() {
  return JSON.parse(JSON.stringify(TOOL_DEFINITIONS));
}

module.exports = { TOOL_DEFINITIONS, getToolSchema };
