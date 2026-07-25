CREATE TABLE "rate_limits" (
	"bucket_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_bucket_key_window_start_pk" PRIMARY KEY("bucket_key","window_start")
);
