const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  OpenAICompatibleProvider,
  ModelProviderError,
  createModelProviderFromEnv,
  messageContentToText,
} = require('../src/services/modelProvider');

describe('OpenAICompatibleProvider', () => {
  test('maps bounded text generation to the common chat-completions interface', async () => {
    let request;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:8080/v1/',
      model: 'offline-model',
      fetchImpl: async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'A grounded answer.' } }] }) };
      },
    });

    assert.equal(await provider.generateText({ systemPrompt: 'Use docs only.', userPrompt: 'Question?', maxTokens: 60 }), 'A grounded answer.');
    assert.equal(request.url, 'http://127.0.0.1:8080/v1/chat/completions');
    assert.equal(request.body.model, 'offline-model');
    assert.equal(request.body.max_tokens, 60);
    assert.equal(request.body.messages.length, 2);
    assert.equal(request.options.headers.authorization, undefined);
  });

  test('uses API-key auth and forwards the same tool schema shape to a cloud API', async () => {
    let request;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.test/v1',
      model: 'cloud-small',
      apiKey: 'test-key',
      fetchImpl: async (_url, options) => {
        request = { options, body: JSON.parse(options.body) };
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
      },
    });
    const tools = [{ type: 'function', function: { name: 'lookupDocs' } }];
    await provider.chatCompletion({
      messages: [{ role: 'user', content: 'Question' }],
      tools,
      toolChoice: 'auto',
      maxTokens: 77,
    });

    assert.equal(request.options.headers.authorization, 'Bearer test-key');
    assert.deepEqual(request.body.tools, tools);
    assert.equal(request.body.tool_choice, 'auto');
    assert.equal(request.body.max_tokens, 77);
  });

  test('clamps output tokens and wraps transport errors with a service status', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'local',
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }),
    });
    const payload = await provider.chatCompletion({ messages: [{ role: 'user', content: 'test' }], maxTokens: 9000 });
    assert.equal(payload.choices[0].message.content, 'ok');

    const offline = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'local',
      fetchImpl: async () => { throw new TypeError('connection refused'); },
    });
    await assert.rejects(offline.chatCompletion({ messages: [{ role: 'user', content: 'test' }] }), (error) => {
      assert.ok(error instanceof ModelProviderError);
      assert.equal(error.statusCode, 503);
      return true;
    });
  });

  test('selects local/cloud implementations and validates cloud credentials', () => {
    const local = createModelProviderFromEnv({ AI_PROVIDER: 'local' }, { fetchImpl: async () => {} });
    assert.equal(local.model, 'local-model');
    assert.equal(local.baseUrl, 'http://127.0.0.1:8080/v1');

    const cloud = createModelProviderFromEnv({
      AI_PROVIDER: 'cloud',
      CLOUD_LLM_API_KEY: 'secret',
      CLOUD_LLM_MODEL: 'small-chat',
      CLOUD_LLM_BASE_URL: 'https://custom.example/v1',
    }, { fetchImpl: async () => {} });
    assert.equal(cloud.model, 'small-chat');
    assert.equal(cloud.baseUrl, 'https://custom.example/v1');
    assert.throws(() => createModelProviderFromEnv({ AI_PROVIDER: 'cloud' }), /CLOUD_LLM_API_KEY/);
    assert.throws(() => createModelProviderFromEnv({ AI_PROVIDER: 'mystery' }), /Unsupported AI_PROVIDER/);
  });

  test('extracts string and multipart response content', () => {
    assert.equal(messageContentToText(' hello '), 'hello');
    assert.equal(messageContentToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
    assert.equal(messageContentToText(null), '');
  });
});
