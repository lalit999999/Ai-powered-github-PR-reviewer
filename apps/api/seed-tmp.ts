import { randomUUID } from "node:crypto";
import { prisma } from "@repo/db";

async function seed(login: string, gid: bigint) {
  const user = await prisma.user.upsert({
    where: { githubUserId: gid },
    update: {},
    create: { githubUserId: gid, githubLogin: login, email: `${login}@example.com`, name: login },
  });
  const token = randomUUID();
  await prisma.session.create({
    data: { sessionToken: token, userId: user.id, expires: new Date(Date.now() + 3600_000) },
  });
  return { login, userId: user.id, token };
}

const a = await seed("behavioral-a", 990001n);
const b = await seed("behavioral-b", 990002n);
process.stdout.write(JSON.stringify({ a, b }) + "\n");
await prisma.$disconnect();
