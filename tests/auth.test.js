const { describe, it } = require("node:test");
const assert = require("node:assert");
const { checkAuth, AUTH_HEADERS, getUnauthorizedPage } = require("../src/auth");

describe("auth module", () => {
  describe("AUTH_HEADERS", () => {
    it("exports tailscale header names", () => {
      assert.strictEqual(AUTH_HEADERS.tailscale.login, "tailscale-user-login");
      assert.strictEqual(AUTH_HEADERS.tailscale.name, "tailscale-user-name");
      assert.strictEqual(AUTH_HEADERS.tailscale.pic, "tailscale-user-profile-pic");
    });

    it("exports cloudflare header names", () => {
      assert.strictEqual(AUTH_HEADERS.cloudflare.email, "cf-access-authenticated-user-email");
    });
  });

  describe("checkAuth()", () => {
    function mockReq(remoteAddress, headers = {}) {
      return { socket: { remoteAddress }, headers };
    }

    it("allows localhost (127.0.0.1) regardless of auth mode", () => {
      const result = checkAuth(mockReq("127.0.0.1"), { mode: "token", token: "secret" });
      assert.strictEqual(result.authorized, true);
      assert.strictEqual(result.user.type, "localhost");
    });

    it("allows localhost (::1) regardless of auth mode", () => {
      const result = checkAuth(mockReq("::1"), { mode: "tailscale", allowedUsers: [] });
      assert.strictEqual(result.authorized, true);
    });

    it("allows localhost (::ffff:127.0.0.1)", () => {
      const result = checkAuth(mockReq("::ffff:127.0.0.1"), { mode: "token", token: "x" });
      assert.strictEqual(result.authorized, true);
    });

    it("allows all when mode is 'none'", () => {
      const result = checkAuth(mockReq("192.168.1.100"), { mode: "none" });
      assert.strictEqual(result.authorized, true);
      assert.strictEqual(result.user, null);
    });

    describe("token mode", () => {
      const authConfig = { mode: "token", token: "my-secret-token" };

      it("allows valid bearer token", () => {
        const req = mockReq("10.0.0.1", { authorization: "Bearer my-secret-token" });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, true);
        assert.strictEqual(result.user.type, "token");
      });

      it("rejects invalid token", () => {
        const req = mockReq("10.0.0.1", { authorization: "Bearer wrong-token" });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
        assert.ok(result.reason.includes("Invalid"));
      });

      it("rejects missing authorization header", () => {
        const req = mockReq("10.0.0.1", {});
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
      });

      it("rejects a token that is a prefix of the real token", () => {
        const req = mockReq("10.0.0.1", { authorization: "Bearer my-secret" });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
      });

      it("rejects when configured token is empty even if header token is empty", () => {
        const req = mockReq("10.0.0.1", { authorization: "Bearer " });
        const result = checkAuth(req, { mode: "token", token: "" });
        assert.strictEqual(result.authorized, false);
      });
    });

    describe("tailscale mode", () => {
      const authConfig = { mode: "tailscale", allowedUsers: ["user@example.com", "*@corp.com"] };

      it("allows user in allowlist", () => {
        const req = mockReq("100.64.0.1", { "tailscale-user-login": "user@example.com" });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, true);
        assert.strictEqual(result.user.type, "tailscale");
        assert.strictEqual(result.user.login, "user@example.com");
      });

      it("allows wildcard domain match", () => {
        const req = mockReq("100.64.0.1", { "tailscale-user-login": "anyone@corp.com" });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, true);
      });

      it("rejects user not in allowlist", () => {
        const req = mockReq("100.64.0.1", { "tailscale-user-login": "hacker@evil.com" });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
        assert.ok(result.reason.includes("not in allowlist"));
      });

      it("rejects when no tailscale header present", () => {
        const req = mockReq("10.0.0.1", {});
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
        assert.ok(result.reason.includes("Tailscale"));
      });

      it("allows wildcard (*) user", () => {
        const config = { mode: "tailscale", allowedUsers: ["*"] };
        const req = mockReq("100.64.0.1", { "tailscale-user-login": "anyone@anywhere.com" });
        const result = checkAuth(req, config);
        assert.strictEqual(result.authorized, true);
      });
    });

    describe("cloudflare mode", () => {
      const authConfig = { mode: "cloudflare", allowedUsers: ["user@example.com"] };

      it("allows user in allowlist", () => {
        const req = mockReq("172.16.0.1", {
          "cf-access-authenticated-user-email": "user@example.com",
        });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, true);
        assert.strictEqual(result.user.type, "cloudflare");
      });

      it("rejects user not in allowlist", () => {
        const req = mockReq("172.16.0.1", {
          "cf-access-authenticated-user-email": "other@example.com",
        });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
      });

      it("rejects when no cloudflare header present", () => {
        const req = mockReq("172.16.0.1", {});
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
        assert.ok(result.reason.includes("Cloudflare"));
      });
    });

    describe("allowlist mode", () => {
      const authConfig = { mode: "allowlist", allowedIPs: ["10.0.0.5", "192.168.1.0/24"] };

      it("allows exact IP match", () => {
        const req = mockReq("10.0.0.5");
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, true);
        assert.strictEqual(result.user.type, "ip");
      });

      it("allows /24 subnet match", () => {
        const req = mockReq("192.168.1.42");
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, true);
      });

      it("rejects IP not in allowlist", () => {
        const req = mockReq("10.0.0.99");
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
        assert.ok(result.reason.includes("not in allowlist"));
      });

      it("ignores x-forwarded-for by default (spoof protection)", () => {
        // Socket IP not in allowlist; spoofed XFF claims an allowed IP.
        // Without trustProxy set, XFF must be ignored -> denied.
        const req = mockReq("172.16.0.1", { "x-forwarded-for": "10.0.0.5, 172.16.0.1" });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
      });

      it("honors x-forwarded-for when trustProxy is enabled", () => {
        const trusted = { ...authConfig, trustProxy: true };
        const req = mockReq("172.16.0.1", { "x-forwarded-for": "10.0.0.5, 172.16.0.1" });
        const result = checkAuth(req, trusted);
        assert.strictEqual(result.authorized, true);
      });

      it("cannot be spoofed via x-forwarded-for even with trustProxy off", () => {
        const req = mockReq("203.0.113.7", { "x-forwarded-for": "127.0.0.1" });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
      });
    });

    it("rejects unknown auth mode", () => {
      const result = checkAuth(mockReq("10.0.0.1"), { mode: "kerberos" });
      assert.strictEqual(result.authorized, false);
      assert.ok(result.reason.includes("Unknown"));
    });
  });

  describe("getUnauthorizedPage()", () => {
    it("returns HTML string", () => {
      const html = getUnauthorizedPage("test reason", null, { mode: "token" });
      assert.ok(html.includes("<!DOCTYPE html>"));
      assert.ok(html.includes("Access Denied"));
      assert.ok(html.includes("test reason"));
    });

    it("includes user info when provided", () => {
      const html = getUnauthorizedPage("denied", { login: "user@test.com" }, { mode: "tailscale" });
      assert.ok(html.includes("user@test.com"));
    });

    it("includes auth mode in output", () => {
      const html = getUnauthorizedPage("denied", null, { mode: "cloudflare" });
      assert.ok(html.includes("cloudflare"));
    });

    it("escapes HTML in the detected user (reflected XSS protection)", () => {
      const html = getUnauthorizedPage(
        "denied",
        { login: "<script>alert(1)</script>" },
        { mode: "tailscale" },
      );
      assert.ok(!html.includes("<script>alert(1)</script>"), "raw script tag must not appear");
      assert.ok(html.includes("&lt;script&gt;"), "should contain escaped markup");
    });

    it("escapes HTML in the reason string", () => {
      const html = getUnauthorizedPage("<img src=x onerror=alert(1)>", null, { mode: "token" });
      assert.ok(!html.includes("<img src=x"), "raw img tag must not appear");
      assert.ok(html.includes("&lt;img"));
    });
  });
});
