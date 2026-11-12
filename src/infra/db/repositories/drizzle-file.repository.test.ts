import { eq } from "drizzle-orm";

import { parseEnv } from "@/env";
import { createDb } from "@/infra/db/client";
import { migrateDatabase } from "@/infra/db/migrate";
import { createDrizzleFileRepository } from "@/infra/db/repositories/drizzle-file.repository";
import { user as userTable } from "@/infra/db/schema";
import { registerFileRepositoryContractSuite } from "../../../../tests/contracts/file-repository.contract";

registerFileRepositoryContractSuite("drizzle-libsql", async () => {
  const env = parseEnv({ NODE_ENV: "test", DATABASE_URL: ":memory:" });
  const { db, close } = createDb(env);
  await migrateDatabase(db);

  return {
    repository: createDrizzleFileRepository(db),
    createUser: async (label = "user") => {
      const [inserted] = await db
        .insert(userTable)
        .values({
          name: `${label} User`,
          email: `${label}-${crypto.randomUUID()}@example.com`,
        })
        .returning({ id: userTable.id });
      return inserted.id;
    },
    deleteUser: async (userId: string) => {
      await db.delete(userTable).where(eq(userTable.id, userId));
    },
    cleanup: close,
  };
});
