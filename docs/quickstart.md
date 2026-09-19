# llm-keyrot quickstart

## Who this is for

Node.js developers building LLM scripts, batch tasks, agents, or eval harnesses that need practical 429 recovery.

## 1) Install

```bash
npm install llm-keyrot
```

## 2) Try without real API keys

```bash
node examples/mock-rotation-demo.js
node examples/mock-fallback-demo.js
```

## 3) Integrate with your provider

- Keep active key in memory/env.
- Call `rotator.onRateLimit(provider, failure)` when your HTTP/SDK call gets rate-limited.
- If result is `{ kind: 'retry' }`, retry the original request.

## 4) Optional adapters

- OpenAI SDK wrapper: `llm-keyrot/adapters/openai-node.js`
- Generic HTTP wrapper: `llm-keyrot/adapters/http-interceptor.js`

## 5) Shutdown

Call `rotator.dispose()` when your process exits or worker shuts down.
