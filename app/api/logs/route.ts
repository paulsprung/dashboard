import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET() { await requireUser(['OWNER', 'ADMIN', 'READONLY', 'USER']); const logs = await prisma.auditLog.findMany({ take: 200, orderBy: { createdAt: 'desc' } }); return NextResponse.json({ logs }); }
