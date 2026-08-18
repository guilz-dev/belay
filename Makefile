.PHONY: lint typecheck test build corpus verify verify-parallel dogfood dev-refresh

lint:
	pnpm lint

typecheck:
	pnpm typecheck

test:
	pnpm test

build:
	pnpm build

corpus:
	pnpm corpus

probe-adversarial:
	pnpm probe:adversarial

probe-coverage:
	pnpm probe:coverage

corpus-ratchet:
	pnpm corpus:ratchet

verify: lint typecheck test

verify-parallel:
	@set -e; \
	(pnpm lint) & LINT_PID=$$!; \
	(pnpm typecheck) & TYPECHECK_PID=$$!; \
	(pnpm test) & TEST_PID=$$!; \
	status=0; \
	wait $$LINT_PID || status=1; \
	wait $$TYPECHECK_PID || status=1; \
	wait $$TEST_PID || status=1; \
	exit $$status

# Source-built CLI; no global `belay` install required.
dogfood:
	./scripts/dev-dogfood.sh

# Rebuild hooks/runtime from source and switch to dogfood mode (no git pull).
dev-refresh:
	./scripts/dev-refresh.sh
