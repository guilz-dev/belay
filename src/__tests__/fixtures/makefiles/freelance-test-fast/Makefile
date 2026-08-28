.PHONY: _start_test_deps test-fast

TEST_RSPEC_ARGS = $(or $(ARGS),spec)
TEST_DOCKER_RUN = docker-compose run --rm test

_start_test_deps:
	@for c in freelance-db freelance-redis freelancemodiscojp-minio-1 freelance_project-minio-1; do docker start $$c >/dev/null 2>&1 || true; done

test-fast: _start_test_deps
	$(TEST_DOCKER_RUN) /bin/bash -lc "bundle exec rspec $(TEST_RSPEC_ARGS)"
