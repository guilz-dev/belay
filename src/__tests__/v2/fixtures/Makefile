build:
	tsc -p tsconfig.json

release:
	git push --force origin main
	aws s3 sync ./dist s3://bucket
