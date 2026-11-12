import { eq } from "drizzle-orm";

import { parseEnv } from "@/env";
import { createDb } from "@/infra/db/client";
import { migrateDatabase } from "@/infra/db/migrate";
import { createDrizzleTaskRepository } from "@/infra/db/repositories/drizzle-task.repository";
import { user as userTable } from "@/infra/db/schema";
import { registerTaskRepositoryContractSuite } from "../../../../tests/contracts/task-repository.contract";

registerTaskRepositoryContractSuite("drizzle-libsql", async () => {
  const env = parseEnv({ NODE_ENV: "test", DATABASE_URL: ":memory:" });
  const { db, close } = createDb(env);
  await migrateDatabase(db);

  return {
    repository: createDrizzleTaskRepository(db),
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
