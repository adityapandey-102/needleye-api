# Project Scale & Engineering Strategy

Internal Line-of-Business (LOB) app. ~100 users, ~300 orders/month, single
organization, business-critical data. Accuracy, maintainability, and
reliability matter far more than extreme scalability. **Do not overengineer.**
Always prefer the simplest solution that satisfies the current requirement
while remaining extensible.

## Mandatory, non-negotiable

Consistent architecture · clean code · SOLID · high cohesion · low coupling ·
proper authentication/authorization · strong validation · consistent error
handling · structured backend logging · proper database migrations ·
development seed data · a Dockerized backend dev environment · CI pipelines ·
comprehensive documentation.

## Keep it simple

Unless explicitly requested, do **not** introduce: microservices, Kubernetes,
Redis, CQRS, Event Sourcing, a distributed event bus, Kafka, RabbitMQ,
distributed tracing (Jaeger/Zipkin/OpenTelemetry), complex caching layers,
multi-region deployment, or highly abstract generic frameworks.

**The current Feature-Based Modular Monolith (see README's "Architecture") is
the correct architecture for this project. Keep improving it, don't replace
it.**

## Testing strategy (Testing Pyramid — don't test every line equally)

- **Unit tests (highest priority)**: business logic -- domain services,
  business rules, validation, permission/RBAC logic, calculations, order
  number generation. These should be the majority of tests. This maps
  directly onto every module's `domain/*.rules.ts` file.
- **Integration tests**: Repository ↔ Database, Service ↔ Repository,
  authentication, storage providers, API endpoints, DB transactions.
- **E2E tests**: only for critical workflows -- login, create order, update
  order, upload images, record payment, search orders. Not every page/button.
- **Manual testing** before calling a feature done: desktop, mobile
  responsiveness, auth, authz, error scenarios, the important workflows.

## Performance

Appropriate for realistic concurrent usage at this scale -- not
enterprise-scale load testing. Every query gets reviewed for N+1s, duplicate
queries, unnecessary joins, excessive round trips, unnecessary columns. No
premature optimization.

## Monitoring & logging

Track API errors, unhandled exceptions, login failures, DB errors, slow
queries, request duration. Structured logging (pino, already in place).
Never log passwords, tokens, secrets, or personal/confidential data.

## Security

Every backend change gets a security review: auth, authz, JWT validation,
RBAC, input validation, SQL injection prevention, file upload validation,
secure HTTP headers, XSS protection, CSRF protection where applicable.

## CI strategy

CI only -- no complex CD until a deployment platform is finalized.

- **Frontend CI**: install, lint, typecheck, build.
- **Backend CI**: install, lint, typecheck, unit tests, integration tests,
  Docker image build verification.

## Local development

Minimal setup. One command should: start PostgreSQL, apply migrations, seed
dev data, start the backend. (Frontend still starts manually, separately.)
Dev data should reset between local sessions when appropriate.

## Engineering standard — applies to every future change

Every implementation, refactor, optimization, bug fix, and feature must
automatically include a review of whether these need updating -- **do not
wait to be asked**:

Automated tests · documentation · architecture documentation · flow diagrams
(when architecture/workflow changes) · API documentation (`openapi.yaml`) ·
logging · error handling · validation · security · performance · database
migrations · seed data · environment configuration · CI configuration.

## Definition of done

Not done just because the feature works. Done means: implemented correctly ·
existing functionality unaffected · tests added/updated · documentation
current · logging reviewed · error handling reviewed · security reviewed ·
performance reviewed · migrations updated if needed · seed data updated if
needed · build succeeds · typecheck passes · lint passes · CI passes.

Always balance maintainability, simplicity, and production readiness. Avoid
overengineering. Prefer the simplest architecture and implementation that
cleanly solves the problem while staying extensible.
