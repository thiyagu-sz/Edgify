CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"rating" text,
	"message" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"source" text,
	"route" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_type_valid" CHECK (type in ('bug', 'feature', 'general', 'positive', 'performance', 'other')),
	CONSTRAINT "feedback_rating_valid" CHECK (rating is null or rating in ('good', 'okay', 'needs_improvement')),
	CONSTRAINT "feedback_status_valid" CHECK (status in ('new', 'triaged', 'closed')),
	CONSTRAINT "feedback_source_valid" CHECK (source is null or source in ('workspace', 'prompt')),
	CONSTRAINT "feedback_message_length" CHECK (char_length(message) between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_user_created_idx" ON "feedback" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "feedback_status_created_idx" ON "feedback" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "feedback_type_idx" ON "feedback" USING btree ("type");