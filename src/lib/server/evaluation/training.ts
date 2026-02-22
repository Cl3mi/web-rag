/**
 * Training & Model Registry Service
 *
 * LoRA training pipeline (manual trigger) and model management.
 * Training uses Ollama-compatible workflow.
 */

import { sql } from '$lib/server/db/client';
import { exportTrainingData } from './preferences';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const DEFAULT_OUTPUT_DIR = './training_output';

/**
 * Export training dataset to a JSONL file
 */
export async function exportDatasetToFile(options: {
  outputDir?: string;
  filename?: string;
} = {}): Promise<{ path: string; rowCount: number }> {
  const { outputDir = DEFAULT_OUTPUT_DIR, filename = `dataset_${Date.now()}.jsonl` } = options;

  await mkdir(outputDir, { recursive: true });

  const data = await exportTrainingData({ onlyChosen: true });
  const rowCount = data.split('\n').filter(Boolean).length;

  const filePath = join(outputDir, filename);
  await writeFile(filePath, data, 'utf-8');

  return { path: filePath, rowCount };
}

/**
 * Create a training configuration file for LoRA/QLoRA.
 * This generates the config that would be used by training frameworks.
 */
export async function createTrainingConfig(options: {
  baseModel?: string;
  datasetPath: string;
  outputDir?: string;
  loraR?: number;
  loraAlpha?: number;
  epochs?: number;
  batchSize?: number;
  learningRate?: number;
}): Promise<{ configPath: string; config: Record<string, unknown> }> {
  const {
    baseModel = 'qwen2.5:7b',
    datasetPath,
    outputDir = DEFAULT_OUTPUT_DIR,
    loraR = 16,
    loraAlpha = 32,
    epochs = 3,
    batchSize = 4,
    learningRate = 2e-4,
  } = options;

  const config = {
    base_model: baseModel,
    dataset_path: datasetPath,
    output_dir: outputDir,
    method: 'qlora',
    quantization: '4bit',
    lora: {
      r: loraR,
      alpha: loraAlpha,
      dropout: 0.05,
      target_modules: ['q_proj', 'k_proj', 'v_proj', 'o_proj'],
    },
    training: {
      epochs,
      batch_size: batchSize,
      learning_rate: learningRate,
      warmup_steps: 10,
      max_seq_length: 2048,
      gradient_accumulation_steps: 4,
      fp16: true,
    },
  };

  const configPath = join(outputDir, 'training_config.json');
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

  return { configPath, config };
}

/**
 * Run LoRA training pipeline (manual).
 *
 * Steps:
 * 1. Export dataset
 * 2. Create training config
 * 3. Log model to registry
 *
 * Note: Actual training execution depends on the local setup
 * (unsloth, axolotl, etc). This prepares everything and registers
 * the model entry.
 */
export async function trainLoraModel(options: {
  baseModel?: string;
  outputDir?: string;
} = {}): Promise<{
  modelId: string;
  datasetPath: string;
  configPath: string;
  datasetSize: number;
}> {
  const { baseModel = 'qwen2.5:7b', outputDir = DEFAULT_OUTPUT_DIR } = options;

  // Step 1: Export dataset
  const { path: datasetPath, rowCount } = await exportDatasetToFile({ outputDir });

  if (rowCount === 0) {
    throw new Error('No training data available. Run judge and populate preferences first.');
  }

  // Step 2: Create training config
  const { configPath } = await createTrainingConfig({
    baseModel,
    datasetPath,
    outputDir,
  });

  // Step 3: Get average quality score for the dataset
  const qualityResult = await sql`
    SELECT AVG(quality_score) as avg_quality
    FROM rag_preferences
    WHERE chosen = true
  `;
  const avgQuality = Number(qualityResult[0]?.avg_quality) || 0;

  // Step 4: Register model in DB
  const result = await sql`
    INSERT INTO rag_models (base_model, adapter_path, dataset_size, avg_quality_score, active)
    VALUES (${baseModel}, ${outputDir}, ${rowCount}, ${avgQuality}, false)
    RETURNING id
  `;

  return {
    modelId: result[0].id as string,
    datasetPath,
    configPath,
    datasetSize: rowCount,
  };
}

/**
 * List all registered models
 */
export async function listModels(): Promise<Array<{
  id: string;
  baseModel: string;
  adapterPath: string | null;
  datasetSize: number;
  avgQualityScore: number | null;
  active: boolean;
  createdAt: string;
}>> {
  const rows = await sql`
    SELECT id, base_model, adapter_path, dataset_size, avg_quality_score, active, created_at
    FROM rag_models
    ORDER BY created_at DESC
  `;

  return rows.map(r => ({
    id: r.id as string,
    baseModel: r.base_model as string,
    adapterPath: r.adapter_path as string | null,
    datasetSize: Number(r.dataset_size),
    avgQualityScore: r.avg_quality_score !== null ? Number(r.avg_quality_score) : null,
    active: r.active as boolean,
    createdAt: (r.created_at as Date).toISOString(),
  }));
}

/**
 * Activate a model (deactivate all others first)
 */
export async function activateModel(modelId: string): Promise<void> {
  await sql`UPDATE rag_models SET active = false WHERE active = true`;
  await sql`UPDATE rag_models SET active = true WHERE id = ${modelId}`;
}

/**
 * Get the currently active model
 */
export async function getActiveModel(): Promise<{
  id: string;
  baseModel: string;
  adapterPath: string | null;
} | null> {
  const rows = await sql`
    SELECT id, base_model, adapter_path
    FROM rag_models
    WHERE active = true
    LIMIT 1
  `;

  if (rows.length === 0) return null;

  return {
    id: rows[0].id as string,
    baseModel: rows[0].base_model as string,
    adapterPath: rows[0].adapter_path as string | null,
  };
}
