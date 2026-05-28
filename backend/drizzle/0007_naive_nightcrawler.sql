CREATE TABLE "gmail_credentials" (
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"refresh_token" "bytea" NOT NULL,
	"scope" text NOT NULL,
	"email" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_credentials_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "gmail_credentials" ADD CONSTRAINT "gmail_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_gmail_credentials_tenant" ON "gmail_credentials" USING btree ("tenant_id");