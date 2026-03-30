CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"domain" varchar(255) NOT NULL,
	"title" text,
	"content_hash" varchar(64) NOT NULL,
	"raw_html" text,
	"raw_content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"query_id" uuid NOT NULL,
	"pipeline" varchar(20) NOT NULL,
	"retrieved_ids" jsonb NOT NULL,
	"scores" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"latency_ms" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"pipeline" varchar(20) NOT NULL,
	"config" jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb,
	"status" varchar(20) DEFAULT 'running',
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "facts_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"fact_index" integer NOT NULL,
	"content" text NOT NULL,
	"category" varchar(20) NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"dense_embedding" text,
	"sparse_vector" jsonb DEFAULT '{}'::jsonb,
	"source_context" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag_judge_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"groundedness_score" integer NOT NULL,
	"completeness_score" integer NOT NULL,
	"correctness_score" integer NOT NULL,
	"hallucination" boolean NOT NULL,
	"judge_mean" real NOT NULL,
	"judge_std" real NOT NULL,
	"failure_type" varchar(30),
	"answerable_from_context" boolean,
	"judge_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_model" text NOT NULL,
	"adapter_path" text,
	"dataset_size" integer DEFAULT 0 NOT NULL,
	"avg_quality_score" real,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question" text NOT NULL,
	"context" text NOT NULL,
	"answer" text NOT NULL,
	"quality_score" real,
	"hallucination" boolean DEFAULT false NOT NULL,
	"chosen" boolean DEFAULT false NOT NULL,
	"rejected" boolean DEFAULT false NOT NULL,
	"source" varchar(20) DEFAULT 'llm_judge' NOT NULL,
	"evaluation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag_runs_evaluation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"query_id" uuid NOT NULL,
	"pipeline_name" varchar(20) NOT NULL,
	"question" text NOT NULL,
	"retrieved_doc_ids" jsonb NOT NULL,
	"retrieved_context" text NOT NULL,
	"generated_answer" text NOT NULL,
	"top_k" integer NOT NULL,
	"rerank_enabled" boolean DEFAULT false NOT NULL,
	"model_name" text NOT NULL,
	"recall_at_k" real,
	"ndcg" real,
	"mrr" real,
	"latency_ms" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query" text NOT NULL,
	"expected_document_ids" jsonb NOT NULL,
	"category" varchar(100),
	"difficulty" varchar(20) DEFAULT 'medium',
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traditional_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"content_markdown" text NOT NULL,
	"dense_embedding" text,
	"sparse_vector" jsonb DEFAULT '{}'::jsonb,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluation_results" ADD CONSTRAINT "evaluation_results_run_id_evaluation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_results" ADD CONSTRAINT "evaluation_results_query_id_test_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."test_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts_chunks" ADD CONSTRAINT "facts_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_judge_results" ADD CONSTRAINT "rag_judge_results_evaluation_id_rag_runs_evaluation_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."rag_runs_evaluation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_preferences" ADD CONSTRAINT "rag_preferences_evaluation_id_rag_runs_evaluation_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."rag_runs_evaluation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_runs_evaluation" ADD CONSTRAINT "rag_runs_evaluation_run_id_evaluation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_runs_evaluation" ADD CONSTRAINT "rag_runs_evaluation_query_id_test_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."test_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traditional_chunks" ADD CONSTRAINT "traditional_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_url_idx" ON "documents" USING btree ("url");--> statement-breakpoint
CREATE INDEX "documents_domain_idx" ON "documents" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "documents_content_hash_idx" ON "documents" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "evaluation_results_run_idx" ON "evaluation_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "evaluation_results_query_idx" ON "evaluation_results" USING btree ("query_id");--> statement-breakpoint
CREATE INDEX "evaluation_results_pipeline_idx" ON "evaluation_results" USING btree ("pipeline");--> statement-breakpoint
CREATE INDEX "evaluation_runs_status_idx" ON "evaluation_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "evaluation_runs_started_at_idx" ON "evaluation_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "facts_chunks_document_idx" ON "facts_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "facts_chunks_category_idx" ON "facts_chunks" USING btree ("category");--> statement-breakpoint
CREATE INDEX "facts_chunks_confidence_idx" ON "facts_chunks" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX "rag_judge_evaluation_idx" ON "rag_judge_results" USING btree ("evaluation_id");--> statement-breakpoint
CREATE INDEX "rag_judge_failure_type_idx" ON "rag_judge_results" USING btree ("failure_type");--> statement-breakpoint
CREATE INDEX "rag_models_active_idx" ON "rag_models" USING btree ("active");--> statement-breakpoint
CREATE INDEX "rag_preferences_chosen_idx" ON "rag_preferences" USING btree ("chosen");--> statement-breakpoint
CREATE INDEX "rag_preferences_rejected_idx" ON "rag_preferences" USING btree ("rejected");--> statement-breakpoint
CREATE INDEX "rag_preferences_source_idx" ON "rag_preferences" USING btree ("source");--> statement-breakpoint
CREATE INDEX "rag_runs_eval_run_idx" ON "rag_runs_evaluation" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "rag_runs_eval_query_idx" ON "rag_runs_evaluation" USING btree ("query_id");--> statement-breakpoint
CREATE INDEX "rag_runs_eval_pipeline_idx" ON "rag_runs_evaluation" USING btree ("pipeline_name");--> statement-breakpoint
CREATE INDEX "test_queries_category_idx" ON "test_queries" USING btree ("category");--> statement-breakpoint
CREATE INDEX "test_queries_difficulty_idx" ON "test_queries" USING btree ("difficulty");--> statement-breakpoint
CREATE INDEX "traditional_chunks_document_idx" ON "traditional_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "traditional_chunks_chunk_index_idx" ON "traditional_chunks" USING btree ("document_id","chunk_index");