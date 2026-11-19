-- M1: Row-Level Security (spec §8). Requires Supabase's auth.uid() and the authenticated role.
-- Helpers are SECURITY DEFINER so they can read memberships without recursing into its policies.

create function app.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from memberships m where m.user_id = auth.uid() and m.org_id = p_org)
$$;

-- true if the user has an org-wide membership, or one scoped to this workspace
create function app.can_access_workspace(p_org uuid, p_ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from memberships m
    where m.user_id = auth.uid() and m.org_id = p_org
      and (m.workspace_id is null or m.workspace_id = p_ws))
$$;

-- p_ws NULL => org-wide membership required; otherwise org-wide or that workspace
create function app.has_role(p_org uuid, p_ws uuid, p_roles member_role[]) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from memberships m
    where m.user_id = auth.uid() and m.org_id = p_org and m.role = any(p_roles)
      and (m.workspace_id is null or (p_ws is not null and m.workspace_id = p_ws)))
$$;

-- Onboarding: creates org + default workspace + owner membership atomically (orgs have no INSERT policy).
create function app.create_org(p_name text, p_slug text, p_type org_type) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid; v_ws uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into orgs(name, slug, type) values (p_name, p_slug, p_type) returning id into v_org;
  insert into workspaces(org_id, name, slug) values (v_org, p_name, 'default') returning id into v_ws;
  insert into memberships(user_id, org_id, workspace_id, role) values (auth.uid(), v_org, null, 'owner');
  insert into audit_log(org_id, actor_user_id, action, entity, entity_id) values (v_org, auth.uid(), 'org.create', 'org', v_org::text);
  return v_org;
end $$;

grant usage on schema app to authenticated;
grant execute on function app.is_org_member(uuid), app.can_access_workspace(uuid,uuid),
  app.has_role(uuid,uuid,member_role[]), app.create_org(text,text,org_type) to authenticated;
revoke execute on function app.create_org(text,text,org_type) from public, anon;

alter table orgs enable row level security;
alter table workspaces enable row level security;
alter table users enable row level security;
alter table memberships enable row level security;
alter table invitations enable row level security;
alter table properties enable row level security;
alter table connections enable row level security;
alter table external_listings enable row level security;
alter table listing_mappings enable row level security;
alter table audit_log enable row level security;

grant select, insert, update, delete on all tables in schema public to authenticated;
revoke all on all tables in schema public from anon;

-- orgs: no INSERT (use app.create_org). Delete is owner-only.
create policy orgs_select on orgs for select to authenticated using (app.is_org_member(id));
create policy orgs_update on orgs for update to authenticated
  using (app.has_role(id, null, '{owner,admin}')) with check (app.has_role(id, null, '{owner,admin}'));
create policy orgs_delete on orgs for delete to authenticated using (app.has_role(id, null, '{owner}'));

-- workspaces
create policy ws_select on workspaces for select to authenticated using (app.can_access_workspace(org_id, id));
create policy ws_insert on workspaces for insert to authenticated with check (app.has_role(org_id, null, '{owner,admin}'));
create policy ws_update on workspaces for update to authenticated
  using (app.has_role(org_id, null, '{owner,admin,editor}')) with check (app.has_role(org_id, null, '{owner,admin,editor}'));
create policy ws_delete on workspaces for delete to authenticated using (app.has_role(org_id, null, '{owner,admin}'));

-- users: self, or someone who shares an org with me (owner/admin only see roster)
create policy users_select on users for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from memberships mine join memberships theirs on theirs.org_id = mine.org_id
    where mine.user_id = auth.uid() and mine.workspace_id is null and mine.role in ('owner','admin')
      and theirs.user_id = users.id));
create policy users_insert on users for insert to authenticated with check (id = auth.uid());
create policy users_update on users for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- memberships: own rows, or owner/admin of the org sees all; only owner/admin write
create policy mem_select on memberships for select to authenticated using (
  user_id = auth.uid() or app.has_role(org_id, null, '{owner,admin}'));
create policy mem_insert on memberships for insert to authenticated with check (app.has_role(org_id, null, '{owner,admin}'));
create policy mem_update on memberships for update to authenticated
  using (app.has_role(org_id, null, '{owner,admin}')) with check (app.has_role(org_id, null, '{owner,admin}'));
create policy mem_delete on memberships for delete to authenticated using (app.has_role(org_id, null, '{owner,admin}'));

create policy inv_all on invitations for all to authenticated
  using (app.has_role(org_id, null, '{owner,admin}')) with check (app.has_role(org_id, null, '{owner,admin}'));

-- properties: read by anyone with workspace access; write by owner/admin/editor
create policy prop_select on properties for select to authenticated using (app.can_access_workspace(org_id, workspace_id));
create policy prop_write on properties for all to authenticated
  using (app.has_role(org_id, workspace_id, '{owner,admin,editor}'))
  with check (app.has_role(org_id, workspace_id, '{owner,admin,editor}'));

-- connections & listings: invisible to client roles; connection writes owner/admin only
create policy conn_select on connections for select to authenticated using (app.has_role(org_id, workspace_id, '{owner,admin,editor}'));
create policy conn_write on connections for all to authenticated
  using (app.has_role(org_id, null, '{owner,admin}')) with check (app.has_role(org_id, null, '{owner,admin}'));
create policy el_select on external_listings for select to authenticated using (app.has_role(org_id, workspace_id, '{owner,admin,editor}'));
create policy el_write on external_listings for all to authenticated
  using (app.has_role(org_id, workspace_id, '{owner,admin,editor}')) with check (app.has_role(org_id, workspace_id, '{owner,admin,editor}'));
create policy lm_all on listing_mappings for all to authenticated
  using (app.has_role(org_id, null, '{owner,admin,editor}')) with check (app.has_role(org_id, null, '{owner,admin,editor}'));

-- audit_log: owner/admin read; any member may append rows attributed to themselves
create policy audit_select on audit_log for select to authenticated using (app.has_role(org_id, null, '{owner,admin}'));
create policy audit_insert on audit_log for insert to authenticated
  with check (app.is_org_member(org_id) and actor_user_id = auth.uid());

-- Secret columns are never readable via the app role (service role / adminDb only).
-- Column-level privileges: drop the table grant, re-grant every column except secrets.
-- Consequence: app queries must list columns explicitly (no `select *` on connections).
revoke select on connections from authenticated;
grant select (id, org_id, workspace_id, provider, display_name, credentials_meta, token_expires_at,
              status, last_error, last_synced_at, created_at) on connections to authenticated;
