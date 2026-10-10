import assert from "node:assert/strict";
import test from "node:test";

import { ModelCache, noModelsError, pickModel } from "../dist/models.js";
import { ZcodeProtocolError } from "../dist/protocol.js";

const GLM = {
  providerId: "account:zai-individual-coding-plan",
  modelId: "GLM-5.3",
  reasoning: { defaultLevel: "max" },
};
const FLASH = {
  providerId: "account:zai-individual-coding-plan",
  modelId: "GLM-5.3-Flash",
  reasoning: { defaultLevel: "low" },
};

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("pickModel: empty list throws ZcodeProtocolError (not a TypeError)", () => {
  withEnv({ ZCODE_MODEL: undefined, ZCODE_REASONING: undefined }, () => {
    assert.throws(
      () => pickModel([], undefined),
      (e) => e instanceof ZcodeProtocolError && /no models available/.test(e.message),
    );
    // the exact regression: no requested model used to hit models[0].reasoning
    assert.throws(() => pickModel([], undefined), (e) => !(e instanceof TypeError));
  });
});

test("pickModel: empty list distinguishes no-credentials from still-loading", () => {
  const noCred = noModelsError({ state: "no-credentials", preferred: "account:zai-individual-coding-plan" });
  assert.match(noCred.message, /credentials/i);
  assert.match(noCred.message, /log in/i);
  assert.match(noCred.message, /account:zai-individual-coding-plan/);

  const loading = noModelsError({ state: "timeout", waitedMs: 10000 });
  assert.match(loading.message, /10000ms/);
  assert.match(loading.message, /retry/i);

  assert.notEqual(noCred.message, loading.message);
});

test("pickModel: unknown requested model lists what is available", () => {
  withEnv({ ZCODE_MODEL: undefined, ZCODE_REASONING: undefined }, () => {
    assert.throws(
      () => pickModel([GLM, FLASH], "GLM-4.5"),
      (e) => e instanceof ZcodeProtocolError && /GLM-5.3, .*GLM-5.3-Flash/.test(e.message),
    );
  });
});

test("pickModel: default prefers GLM-5.3, else the first model", () => {
  withEnv({ ZCODE_MODEL: undefined, ZCODE_REASONING: undefined }, () => {
    assert.equal(pickModel([FLASH, GLM]).model.modelId, "GLM-5.3");
    assert.equal(pickModel([FLASH]).model.modelId, "GLM-5.3-Flash");
  });
});

test("pickModel: reasoning precedence is env > model default > max", () => {
  withEnv({ ZCODE_MODEL: undefined, ZCODE_REASONING: undefined }, () => {
    assert.equal(pickModel([GLM]).reasoning, "max"); // model default
    assert.equal(pickModel([FLASH]).reasoning, "low"); // model default
  });
  withEnv({ ZCODE_MODEL: undefined, ZCODE_REASONING: "high" }, () => {
    assert.equal(pickModel([GLM]).reasoning, "high"); // env wins
  });
});

test("ModelCache never stores an empty model list", () => {
  const cache = new ModelCache();
  cache.set("/a", []);
  assert.equal(cache.get("/a"), undefined);
  cache.set("/a", [GLM]);
  assert.equal(cache.get("/a")?.length, 1);
  cache.set("/a", []); // an empty refresh must not evict the last good list
  assert.equal(cache.get("/a")?.length, 1);
});
