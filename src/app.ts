import configureOpenAPI from "@/lib/configure-open-api";
import createApp from "@/lib/create-app";
import { requireAuth } from "@/middlewares/auth";
import auth from "@/routes/auth/auth.index";
import index from "@/routes/index.route";
import tasks from "@/routes/tasks/tasks.index";
import users from "@/routes/users/users.index";

const app = createApp();

configureOpenAPI(app);

app.route("/", auth);
app.route("/", index);

app.use("/tasks/*", requireAuth);
app.use("/tasks", requireAuth);
app.route("/", tasks);

app.use("/users/*", requireAuth);
app.use("/users", requireAuth);
app.route("/", users);

export type AppType = typeof tasks & typeof users;

export default app;
