const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  TOKEN_RATES,
  emptyUsageBucket,
  calculateCostForBucket,
  getConfiguredRates,
  resolveBucketCost,
} = require("../src/tokens");

describe("tokens module", () => {
  describe("TOKEN_RATES", () => {
    it("has input rate", () => {
      assert.strictEqual(TOKEN_RATES.input, 15.0);
    });

    it("has output rate", () => {
      assert.strictEqual(TOKEN_RATES.output, 75.0);
    });

    it("has cache read rate", () => {
      assert.strictEqual(TOKEN_RATES.cacheRead, 1.5);
    });

    it("has cache write rate", () => {
      assert.strictEqual(TOKEN_RATES.cacheWrite, 18.75);
    });
  });

  describe("emptyUsageBucket()", () => {
    it("returns object with zero values", () => {
      const bucket = emptyUsageBucket();
      assert.strictEqual(bucket.input, 0);
      assert.strictEqual(bucket.output, 0);
      assert.strictEqual(bucket.cacheRead, 0);
      assert.strictEqual(bucket.cacheWrite, 0);
      assert.strictEqual(bucket.cost, 0);
      assert.strictEqual(bucket.requests, 0);
    });

    it("returns a new object each time", () => {
      const a = emptyUsageBucket();
      const b = emptyUsageBucket();
      assert.notStrictEqual(a, b);
      a.input = 100;
      assert.strictEqual(b.input, 0);
    });
  });

  describe("calculateCostForBucket()", () => {
    it("calculates cost for given token counts", () => {
      const bucket = {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
      };
      const result = calculateCostForBucket(bucket);
      assert.strictEqual(result.inputCost, 15.0);
      assert.strictEqual(result.outputCost, 75.0);
      assert.strictEqual(result.cacheReadCost, 1.5);
      assert.strictEqual(result.cacheWriteCost, 18.75);
      assert.strictEqual(result.totalCost, 15.0 + 75.0 + 1.5 + 18.75);
    });

    it("returns zero cost for empty bucket", () => {
      const bucket = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const result = calculateCostForBucket(bucket);
      assert.strictEqual(result.totalCost, 0);
    });

    it("accepts custom rates", () => {
      const bucket = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
      const customRates = { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 };
      const result = calculateCostForBucket(bucket, customRates);
      assert.strictEqual(result.inputCost, 10.0);
      assert.strictEqual(result.totalCost, 10.0);
    });

    it("calculates proportionally for partial token counts", () => {
      const bucket = { input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0 };
      const result = calculateCostForBucket(bucket);
      assert.strictEqual(result.inputCost, 7.5);
    });
  });

  describe("getConfiguredRates()", () => {
    it("returns Opus defaults when no override", () => {
      assert.deepStrictEqual(getConfiguredRates({}), TOKEN_RATES);
      assert.deepStrictEqual(getConfiguredRates(undefined), TOKEN_RATES);
    });

    it("applies partial overrides from config.billing.tokenRates", () => {
      const rates = getConfiguredRates({ billing: { tokenRates: { input: 3, output: 15 } } });
      assert.strictEqual(rates.input, 3);
      assert.strictEqual(rates.output, 15);
      // Untouched rates fall back to defaults
      assert.strictEqual(rates.cacheRead, TOKEN_RATES.cacheRead);
      assert.strictEqual(rates.cacheWrite, TOKEN_RATES.cacheWrite);
    });

    it("ignores non-numeric overrides", () => {
      const rates = getConfiguredRates({ billing: { tokenRates: { input: "cheap" } } });
      assert.strictEqual(rates.input, TOKEN_RATES.input);
    });
  });

  describe("resolveBucketCost()", () => {
    it("prefers the recorded cost when present (model-accurate)", () => {
      // Tokens would estimate to $90 at Opus rates, but recorded cost is $2.
      const bucket = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, cost: 2 };
      const result = resolveBucketCost(bucket);
      assert.strictEqual(result.cost, 2);
      assert.strictEqual(result.source, "recorded");
    });

    it("falls back to rate-based estimate when no recorded cost", () => {
      const bucket = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      const result = resolveBucketCost(bucket);
      assert.strictEqual(result.cost, 15.0);
      assert.strictEqual(result.source, "estimated");
    });

    it("uses custom rates for the estimate", () => {
      const bucket = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      const result = resolveBucketCost(bucket, {
        input: 3,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      assert.strictEqual(result.cost, 3);
      assert.strictEqual(result.source, "estimated");
    });
  });
});
