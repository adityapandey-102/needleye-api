# LLD — Backend Request Lifecycle (Whole-System)

The full path of one HTTP request through `needleye-api`, from `index.ts` to
the response: the middleware chain, a module's Controller → Service → Domain
rules/Repository Port → Infrastructure → Postgres, back out through the
Presenter, and the error-handling path.

```mermaid
flowchart TD
    Client["needleye-web<br/>(fetch, Authorization: Bearer &lt;token&gt;)"] --> Index["index.ts<br/>process entry point, calls .listen()"]
    Index --> CreateApp["app.ts: createApp()<br/>composition root -- mounts every module's router"]

    CreateApp --> MW1["requestLogger<br/>common/logger/request-logger.middleware.ts (pino-http)<br/>+ userId/role, redacts authorization/cookie"]
    MW1 --> MWctx["requestContextMiddleware<br/>common/context/ -- AsyncLocalStorage { requestId, userId, role }<br/>flows to audit + slow-query loggers"]
    MWctx --> MW1b["helmet()<br/>secure headers (HSTS, nosniff, frameguard, ...); CSP off"]
    MW1b --> MW2["cors()<br/>CORS_ALLOWED_ORIGIN"]
    MW2 --> MW3["express.json()"]
    MW3 --> Health{"GET /health"}
    Health -->|match| HealthResp["200 { status, timestamp }"]
    Health -->|no match| Docs{"GET /api-docs"}
    Docs -->|match| SwaggerUI["swagger-ui-express<br/>docs/openapi.ts + openapi.yaml"]
    Docs -->|no match| ApiV1["/api/v1 router"]

    ApiV1 --> R1["/auth<br/>modules/auth/api/auth.routes.ts<br/>(sensitive routes behind authRateLimiter)"]
    ApiV1 --> R2["/users<br/>modules/users/api/users.routes.ts"]
    ApiV1 --> R3["/orders/:orderId/payments<br/>modules/payments/api/payments.routes.ts"]
    ApiV1 --> R4["/orders<br/>modules/orders/api/orders.routes.ts"]
    ApiV1 --> R5["/team-members<br/>modules/team-members/api/team-members.routes.ts"]

    R1 --> RA["requireAuth<br/>common/middleware/auth.middleware.ts"]
    R2 --> RA
    R3 --> RA
    R4 --> RA
    R5 --> RA

    RA -->|"verifyAccessToken() via AuthProvider,<br/>fetchActiveProfile() via Drizzle"| RC["requireCapability(capability)<br/>common/middleware/capability.middleware.ts<br/>checks domain/capabilities.ts CAPABILITY_MATRIX"]
    RC --> VB["validateBody / validateQuery<br/>common/http/validate.middleware.ts (zod DTO schema)"]
    VB --> Ctl["Controller handler<br/>api/*.routes.ts -- reads req, calls Service, shapes res"]

    Ctl --> Svc["Application Service<br/>application/*.service.ts<br/>(AuthService / UsersService / TeamMembersService / PaymentsService / OrdersService)"]

    Svc --> Rules["Domain rule functions<br/>domain/*.rules.ts -- pure, throw AppError subclasses directly"]
    Svc --> Port[["Repository Port (interface)<br/>application/ports/*.port.ts"]]
    Port --> Repo["Drizzle*Repository<br/>infrastructure/drizzle-*.repository.ts"]
    Repo --> Mapper["*.mapper.ts<br/>Drizzle row -> domain Entity"]
    Repo --> DrizzleDB[("db<br/>common/database/drizzle-client.ts<br/>pool wrapped by query-timing (slow-query log)")]
    DrizzleDB --> Postgres[("PostgreSQL<br/>via DATABASE_URL (least-privilege role in prod)")]
    Svc -.->|important business actions| Audit[["AuditLogger<br/>common/audit -> audit_log table"]]

    Svc --> Presenter["Presenter<br/>api/*.presenter.ts -- Entity -> ResponseDto"]
    Presenter --> Ctl

    Repo -.->|Auth + Users repos only| AuthProviderIface[["AuthProvider<br/>common/auth/auth-provider.ts"]]
    AuthProviderIface --> SupabaseAuth[("Supabase Auth / GoTrue")]

    Svc -.->|Orders service only| StorageProviderIface[["StorageProvider<br/>common/storage/storage-provider.ts"]]
    StorageProviderIface --> SupabaseStorage[("Supabase Storage")]

    Ctl -->|"res.status(x).json(dto)"| ClientResp["JSON response"] --> Client

    Ctl -.->|throws AppError subclass| ErrorMW["errorHandler<br/>common/middleware/error.middleware.ts<br/>(the ONLY place an error becomes an HTTP response)"]
    ErrorMW -.-> ErrResp["{ error, code, details? }"] -.-> Client

    ApiV1 -.->|no route matched| NotFoundMW["notFoundHandler<br/>common/middleware/error.middleware.ts"]
    NotFoundMW -.-> ErrResp
```
