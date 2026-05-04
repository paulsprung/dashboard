import { NextResponse } from 'next/server';
import { requireUser, writeAudit } from '@/lib/auth';
import { teamspeakStatus } from '@/lib/action-runner';
import { env } from '@/lib/env';

export async function GET() { const user = await requireUser(['OWNER','ADMIN','USER','READONLY']); const result = await teamspeakStatus(env.tsContainerName); await writeAudit('teamspeak.status','SUCCESS',{userId:user.id,target:env.tsContainerName}); return NextResponse.json(result); }
