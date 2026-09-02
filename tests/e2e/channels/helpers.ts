import { APIRequestContext, APIResponse, expect } from '@playwright/test';
import { sql } from '../helpers/db.js';
import { auth, payload, unique } from '../helpers/actors.js';

/**
 * Shared fixtures for the channel and template catalogue: GET /channels,
 * GET /channels/:id/templates and GET /templates.
 *
 * ChannelsController is declared `@Controller()` with no prefix, so these three
 * sit at the API root beside /auth and /otp rather than under a namespace of
 * their own. Two things make them unlike every other customer route:
 *
 *  - they carry `@SkipOnboarding()`, so the guard that normally stands between
 *    a fresh account and the API steps aside — and with it the deactivation
 *    check that lives in the same guard;
 *  - they carry no `@Roles`, so any authenticated caller reads the same list.
 *
 * Everything else here is about the two filters in ChannelsService —
 * `isActive` on channels, `status = 'published'` on templates — because those
 * are what decide whether a half-written template is offered to a paying
 * customer.
 */

export interface CatalogueChannel {
  id: string;
  name: string;
  displayName: string;
  isActive: boolean;
}

export interface CatalogueTemplate {
  id: string;
  name: string;
  body: string;
  channelId: string;
  status: string;
  channel?: CatalogueChannel;
}

/**
 * Fixtures are named, and never counted.
 *
 * resetDb() truncates users and the money tables but deliberately leaves
 * `channels` and `otp_templates` alone: the SMS channel and its system
 * template are seeded once at boot by ChannelsService.onModuleInit, and every
 * other spec in the run expects them to still be there. So anything these specs
 * insert has to be removed by name afterwards, and no assertion may depend on
 * the total size of the catalogue — admin/overview.spec.ts leaves a soft-deleted
 * template of its own behind.
 */
export const TEMPLATE_FIXTURE = 'E2E Edge';
export const CHANNEL_FIXTURE = 'e2e-edge-';

/** The template ChannelsService seeds on first boot. */
export const SYSTEM_TEMPLATE = 'Standard OTP';

export async function removeFixtures(): Promise<void> {
  await sql(
    `DELETE FROM "otp_templates"
      WHERE "name" LIKE $1
         OR "channelId" IN (SELECT "id" FROM "channels" WHERE "name" LIKE $2)`,
    [`${TEMPLATE_FIXTURE}%`, `${CHANNEL_FIXTURE}%`],
  );
  await sql(`DELETE FROM "channels" WHERE "name" LIKE $1`, [
    `${CHANNEL_FIXTURE}%`,
  ]);
}

/** Errors on this API are `{ code, message }` under `error`. */
export async function errorCode(res: APIResponse): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code ?? '';
}

export const names = (rows: { name: string }[]) => rows.map((row) => row.name);

export async function read<T>(
  request: APIRequestContext,
  token: string,
  path: string,
): Promise<T> {
  const res = await request.get(path, { headers: auth(token) });
  expect(res.status(), `${path}: ${await res.text()}`).toBe(200);
  return payload<T>(res);
}

export const templates = (request: APIRequestContext, token: string) =>
  read<CatalogueTemplate[]>(request, token, '/templates');

export const channelTemplates = (
  request: APIRequestContext,
  token: string,
  channelId: string,
) =>
  read<CatalogueTemplate[]>(request, token, `/channels/${channelId}/templates`);

/** A second channel, so "scoped to this channel" can actually be tested. */
export async function seedChannel(
  opts: { isActive?: boolean } = {},
): Promise<{ id: string; name: string }> {
  const name = `${CHANNEL_FIXTURE}${unique('ch')}`;
  const [row] = await sql<{ id: string }>(
    `INSERT INTO "channels" ("name", "displayName", "isActive")
     VALUES ($1, $2, $3) RETURNING "id"`,
    [name, 'E2E Edge Channel', opts.isActive ?? true],
  );
  return { id: row.id, name };
}
