import { NextResponse } from 'next/server';
import { clearSession, writeAudit } from '@/lib/auth';

export async function POST() { await clearSession(); await writeAudit('auth.logout', 'SUCCESS'); return NextResponse.json({ ok: true }); }
