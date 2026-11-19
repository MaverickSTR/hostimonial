import { afterAll, beforeAll, describe, expect, test } from "vitest";
import postgres from "postgres";
import { createDb, migrate } from "../src";

const URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const admin = postgres(URL, { max: 1, onnotice: () => {} }); // superuser: bypasses RLS, used for seeding only
const db = createDb(URL);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const U = { owner1: id(1), admin1: id(2), editor1: id(3), viewerA: id(4), clientEditA: id(5), owner2: id(6), stranger: id(7) };
const ORG1 = id(101), ORG2 = id(102);
const WS = { a1: id(201), b1: id(202), a2: id(203), b2: id(204) }; // org1: a1,b1  org2: a2,b2
const P = { a1: id(301), b1: id(302), a2: id(303) };

beforeAll(async () => {
  await migrate(URL);
  await admin`truncate orgs, users cascade`;
  for (const [k, v] of Object.entries(U)) await admin`insert into users(id,email) values (${v}, ${k + "@t.dev"})`;
  await admin`insert into orgs(id,name,slug,type) values (${ORG1},'Org1','org1','agency'),(${ORG2},'Org2','org2','agency')`;
  await admin`insert into workspaces(id,org_id,name,slug) values
    (${WS.a1},${ORG1},'A1','a1'),(${WS.b1},${ORG1},'B1','b1'),(${WS.a2},${ORG2},'A2','a2'),(${WS.b2},${ORG2},'B2','b2')`;
  await admin`insert into memberships(user_id,org_id,workspace_id,role) values
    (${U.owner1},${ORG1},null,'owner'),(${U.admin1},${ORG1},null,'admin'),(${U.editor1},${ORG1},null,'editor'),
    (${U.viewerA},${ORG1},${WS.a1},'client_viewer'),(${U.clientEditA},${ORG1},${WS.a1},'client_editor'),
    (${U.owner2},${ORG2},null,'owner')`;
  await admin`insert into properties(id,org_id,workspace_id,name,slug) values
    (${P.a1},${ORG1},${WS.a1},'P a1','p-a1'),(${P.b1},${ORG1},${WS.b1},'P b1','p-b1'),(${P.a2},${ORG2},${WS.a2},'P a2','p-a2')`;
  await admin`insert into connections(org_id,workspace_id,provider,display_name,credentials_enc) values
    (${ORG1},${WS.a1},'hostaway','H1', '\\x00'), (${ORG2},${WS.a2},'guesty','G2','\\x00')`;
});
afterAll(async () => { await admin.end(); await db.end(); });

const as = (sub: string) => <T,>(fn: Parameters<typeof db.withRls<T>>[1]) => db.withRls({ sub }, fn);
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe("cross-tenant isolation (org1 user vs org2 data)", () => {
  for (const [role, uid] of Object.entries({ owner: U.owner1, admin: U.admin1, editor: U.editor1, viewer: U.viewerA, clientEditor: U.clientEditA })) {
    test(`${role} of org1 cannot read any org2 row`, async () => {
      await as(uid)(async (tx) => {
        expect(await tx`select id from orgs where id=${ORG2}`).toHaveLength(0);
        expect(await tx`select id from workspaces where org_id=${ORG2}`).toHaveLength(0);
        expect(await tx`select id from properties where org_id=${ORG2}`).toHaveLength(0);
        expect(await tx`select id from memberships where org_id=${ORG2}`).toHaveLength(0);
        expect(await tx`select id from connections where org_id=${ORG2}`).toHaveLength(0);
      });
    });
  }
  test("owner of org1 cannot write into org2", async () => {
    const o = as(U.owner1);
    await expect(o((tx) => tx`insert into properties(org_id,workspace_id,name,slug) values (${ORG2},${WS.a2},'x','x')`)).rejects.toThrow();
    await o(async (tx) => {
      expect(await tx`update properties set name='hacked' where id=${P.a2} returning id`).toHaveLength(0);
      expect(await tx`delete from properties where id=${P.a2} returning id`).toHaveLength(0);
      expect(await tx`update orgs set name='hacked' where id=${ORG2} returning id`).toHaveLength(0);
      expect(await tx`delete from workspaces where id=${WS.a2} returning id`).toHaveLength(0);
    });
    await expect(o((tx) => tx`insert into memberships(user_id,org_id,workspace_id,role) values (${U.owner1},${ORG2},null,'owner')`)).rejects.toThrow();
  });
  test("cannot attach a property to another org's workspace via mismatched org_id", async () => {
    await expect(as(U.owner1)((tx) => tx`insert into properties(org_id,workspace_id,name,slug) values (${ORG1},${WS.a2},'x','x2')`)).rejects.toThrow();
  });
  test("user with no membership sees nothing", async () => {
    await as(U.stranger)(async (tx) => {
      expect(await tx`select id from orgs`).toHaveLength(0);
      expect(await tx`select id from properties`).toHaveLength(0);
    });
  });
  test("anon role has no table access", async () => {
    await expect(db.sql.begin(async (tx) => { await tx`set local role anon`; await tx`select * from orgs`; })).rejects.toThrow();
  });
});

describe("client_viewer scoped to workspace A1", () => {
  const v = as(U.viewerA);
  test("sees only their workspace and its properties", async () => {
    await v(async (tx) => {
      expect(ids(await tx`select id from workspaces`)).toEqual([WS.a1]);
      expect(ids(await tx`select id from properties`)).toEqual([P.a1]);
    });
  });
  test("sees no connections, external listings or audit log", async () => {
    await v(async (tx) => {
      expect(await tx`select id from connections`).toHaveLength(0);
      expect(await tx`select id from external_listings`).toHaveLength(0);
      expect(await tx`select id from audit_log`).toHaveLength(0);
    });
  });
  test("sees only own membership, not the roster", async () => {
    await v(async (tx) => {
      const rows = await tx`select user_id from memberships`;
      expect(rows.map((r) => r.user_id)).toEqual([U.viewerA]);
    });
  });
  test("cannot write properties, workspaces or memberships", async () => {
    await expect(v((tx) => tx`insert into properties(org_id,workspace_id,name,slug) values (${ORG1},${WS.a1},'x','x3')`)).rejects.toThrow();
    await v(async (tx) => {
      expect(await tx`update properties set name='h' where id=${P.a1} returning id`).toHaveLength(0);
      expect(await tx`update workspaces set name='h' where id=${WS.a1} returning id`).toHaveLength(0);
    });
    await expect(v((tx) => tx`update memberships set role='owner' where user_id=${U.viewerA}`)).resolves.toBeDefined();
    await as(U.viewerA)(async (tx) => {
      const [m] = await tx`select role from memberships where user_id=${U.viewerA}`;
      expect(m!.role).toBe("client_viewer"); // privilege escalation attempt had no effect
    });
  });
});

describe("client_editor", () => {
  test("cannot see connections or manage properties", async () => {
    await as(U.clientEditA)(async (tx) => {
      expect(await tx`select id from connections`).toHaveLength(0);
      expect(ids(await tx`select id from properties`)).toEqual([P.a1]);
      expect(await tx`update properties set name='h' where id=${P.a1} returning id`).toHaveLength(0);
    });
  });
});

describe("org-wide roles", () => {
  test("editor sees all org1 workspaces + properties, can edit properties but not connections", async () => {
    await as(U.editor1)(async (tx) => {
      expect(ids(await tx`select id from workspaces`)).toEqual([WS.a1, WS.b1].sort());
      expect(ids(await tx`select id from properties`)).toEqual([P.a1, P.b1].sort());
      expect(await tx`select id from connections`).toHaveLength(1);
      expect(await tx`update properties set name='ok' where id=${P.b1} returning id`).toHaveLength(1);
      expect(await tx`delete from connections returning id`).toHaveLength(0);
    });
  });
  test("owner and admin can manage connections and members", async () => {
    for (const uid of [U.owner1, U.admin1]) {
      await as(uid)(async (tx) => {
        expect(await tx`select id from memberships`).toHaveLength(5);
        expect(await tx`update connections set display_name='renamed' where org_id=${ORG1} returning id`).toHaveLength(1);
      });
    }
  });
  test("admin cannot delete the org; owner can read audit log", async () => {
    await as(U.admin1)(async (tx) => { expect(await tx`delete from orgs where id=${ORG1} returning id`).toHaveLength(0); });
  });
  test("secret columns are unreadable by the app role", async () => {
    await expect(as(U.owner1)((tx) => tx`select credentials_enc from connections`)).rejects.toThrow(/permission denied/);
    await expect(as(U.owner1)((tx) => tx`select token_cache_enc from connections`)).rejects.toThrow(/permission denied/);
    await as(U.owner1)(async (tx) => { expect(await tx`select credentials_meta from connections`).toHaveLength(1); });
  });
});

describe("onboarding", () => {
  test("create_org makes org + default workspace + owner membership", async () => {
    const fresh = id(900);
    await admin`insert into users(id,email) values (${fresh},'new@t.dev') on conflict do nothing`;
    await as(fresh)(async (tx) => {
      const [{ create_org }] = await tx`select app.create_org('Acme','acme','host')`;
      expect(await tx`select id from orgs where id=${create_org}`).toHaveLength(1);
      expect(await tx`select id from workspaces where org_id=${create_org}`).toHaveLength(1);
      const [m] = await tx`select role from memberships where org_id=${create_org}`;
      expect(m!.role).toBe("owner");
    });
    await expect(as(fresh)((tx) => tx`insert into orgs(name,slug,type) values ('x','x','host')`)).rejects.toThrow();
  });
});
