import { auth } from "@/lib/auth";
import { createRouter } from "@/lib/create-app";
import * as routes from "./auth.routes";

const router = createRouter();

router.use("/api/auth/*", async (c, next) => {
  try {
    c.set("clonedReq", c.req.raw.clone());
  }
  catch {
    // ignore if body cannot be cloned
  }
  await next();
});

const handleAuth = (c: any) => {
  const req = c.get("clonedReq") ?? c.req.raw;
  return auth.handler(req) as any;
};

router
  .openapi(routes.signUpEmail, handleAuth)
  .openapi(routes.signInEmail, handleAuth)
  .openapi(routes.signOut, handleAuth)
  .openapi(routes.getSession, handleAuth)
  .on(["POST", "GET"], "/api/auth/**", (c) => {
    return auth.handler(c.req.raw);
  });

export default router;
