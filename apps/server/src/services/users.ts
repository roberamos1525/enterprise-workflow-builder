import { randomUUID } from "node:crypto";
import { hashPassword, verifyPassword, type AuthUser, type Role } from "../auth.js";
import type { Database } from "../db/database.js";
import { conflict, notFound, unauthorized } from "../errors.js";

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  disabled: number;
  created_at: number;
}

export interface UserView extends AuthUser {
  disabled: boolean;
  createdAt: number;
}

const view = (r: UserRow): UserView => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  disabled: r.disabled === 1,
  createdAt: r.created_at,
});

// Computed once so failed logins for unknown users cost the same as real ones.
let dummyHash: string | undefined;

export class UserService {
  constructor(
    private readonly db: Database,
    private readonly now: () => number,
  ) {}

  create(input: { email: string; name: string; role: Role; password: string }): UserView {
    if (this.db.get("SELECT 1 FROM users WHERE email = ?", input.email)) throw conflict("a user with this email exists");
    const id = randomUUID();
    this.db.run(
      "INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id, input.email.toLowerCase(), input.name, input.role, hashPassword(input.password), this.now(),
    );
    return this.get(id);
  }

  authenticate(email: string, password: string): UserView {
    const row = this.db.get<UserRow>("SELECT * FROM users WHERE email = ?", email);
    if (!row) {
      dummyHash ??= hashPassword("not-a-real-password");
      verifyPassword(password, dummyHash);
      throw unauthorized("invalid email or password");
    }
    if (!verifyPassword(password, row.password_hash) || row.disabled === 1) throw unauthorized("invalid email or password");
    return view(row);
  }

  find(id: string): UserView | undefined {
    const row = this.db.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
    return row ? view(row) : undefined;
  }

  get(id: string): UserView {
    const user = this.find(id);
    if (!user) throw notFound("user");
    return user;
  }

  list(): UserView[] {
    return this.db.all<UserRow>("SELECT * FROM users ORDER BY email").map(view);
  }

  update(id: string, patch: { name?: string | undefined; role?: Role | undefined; disabled?: boolean | undefined; password?: string | undefined }): UserView {
    this.get(id);
    if (patch.name !== undefined) this.db.run("UPDATE users SET name = ? WHERE id = ?", patch.name, id);
    if (patch.role !== undefined) this.db.run("UPDATE users SET role = ? WHERE id = ?", patch.role, id);
    if (patch.disabled !== undefined) this.db.run("UPDATE users SET disabled = ? WHERE id = ?", patch.disabled ? 1 : 0, id);
    if (patch.password !== undefined) this.db.run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(patch.password), id);
    return this.get(id);
  }

  /** Resolves assignee/recipient specs (`email` or `role:<role>`) to active users. */
  resolve(specs: readonly string[]): UserView[] {
    const users = this.list().filter((u) => !u.disabled);
    const out = new Map<string, UserView>();
    for (const raw of specs) {
      const spec = raw.trim().toLowerCase();
      for (const u of users) {
        if (spec.startsWith("role:") ? u.role === spec.slice(5) : u.email === spec) out.set(u.id, u);
      }
    }
    return [...out.values()];
  }

  count(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n ?? 0;
  }
}
