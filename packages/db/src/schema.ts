// Typed row shapes mirroring migrations/*.sql (source of truth for DDL + RLS is the SQL).
export type OrgType = "agency" | "manager" | "host";
export type MemberRole = "owner" | "admin" | "editor" | "client_viewer" | "client_editor";
export interface Org { id: string; name: string; slug: string; type: OrgType; branding: Record<string, unknown> }
export interface Workspace { id: string; orgId: string; name: string; slug: string; websiteUrl: string | null }
export interface Membership { id: string; userId: string; orgId: string; workspaceId: string | null; role: MemberRole }
export interface Property { id: string; orgId: string; workspaceId: string; name: string; slug: string; status: "active" | "archived" }
