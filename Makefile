.PHONY: lint typecheck test build corpus verify verify-parallel

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
