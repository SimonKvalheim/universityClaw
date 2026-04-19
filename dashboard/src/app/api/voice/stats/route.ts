import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '../../../../lib/db/index';

function isLoopback(host: string | null): boolean {
  if (!host) return false;
  let h = host.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = end >= 0 ? h.slice(1, end) : h;
  } else {
    h = h.split(':')[0];
  }
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function readBudget(): number | null {
  const raw = process.env.VOICE_MONTHLY_BUDGET_USD;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function GET(req: Request) {
  if (!isLoopback(req.headers.get('host'))) {
    return NextResponse.json(
      { error: 'voice endpoints are localhost-only' },
      { status: 403 },
    );
  }

  const db = getDb();

  const todayRow = db.all<{ total: number }>(sql`
    SELECT COALESCE(SUM(cost_usd), 0) AS total
    FROM voice_sessions
    WHERE date(started_at) = date('now','localtime')
  `);
  const monthRow = db.all<{ total: number }>(sql`
    SELECT COALESCE(SUM(cost_usd), 0) AS total
    FROM voice_sessions
    WHERE strftime('%Y-%m', started_at) = strftime('%Y-%m', 'now','localtime')
  `);

  const todayUsd = Number(todayRow[0]?.total ?? 0);
  const monthUsd = Number(monthRow[0]?.total ?? 0);

  return NextResponse.json({
    todayUsd,
    monthUsd,
    budgetUsd: readBudget(),
  });
}
