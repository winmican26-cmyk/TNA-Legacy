import { createHash, randomUUID } from 'node:crypto';
import { computeSpecHash, type AtomSpec } from '../../vad-core/src/index.js';

export interface ProducerContext {
  artifacts: string[];
  failure: string | null;
  priorConversation: string[];
}

export interface ProducedArtifact {
  artifactHash: string;
  diffHash: string;
  filesChanged: string[];
  declaredArtifacts: string[];
  evidence?: Array<{
    validatorId: string;
    status: 'PASS' | 'FAIL' | 'NOT_RUN';
    exitCode?: number;
    summary: string;
    outputHash?: string;
  }>;
}

export interface ProducerResult {
  atom_id: string;
  spec_hash: string;
  attempt_number: number;
  producer_id: string;
  provider: string;
  model: string;
  model_version: string;
  started_at: string;
  completed_at: string;
  declared_output_artifacts: string[];
  artifact: ProducedArtifact;
  context: ProducerContext;
  usage: {
    tokens: number;
    cost: number;
    costType: 'measured' | 'estimated' | 'unknown' | 'unavailable';
  };
  /** Vendor-specific observable metadata (Section 8) */
  vendor_metadata: {
    vendor_request_id: string | null;
    response_id: string | null;
    model_snapshot: string | null;
    stop_reason: string | null;
    /** Any additional vendor-specific fields */
    [key: string]: unknown;
  };
}

/**
 * Producer interface that both mock and real vendors implement.
 * Real producers MUST report actual observable metadata from the provider.
 * UNKNOWN / UNAVAILABLE must remain explicit — do not manufacture missing fields.
 */
export interface ModelProducer {
  produce(atom: AtomSpec, context: ProducerContext): Promise<ProducerResult>;
  /** Provider identifier (e.g., 'anthropic', 'openai', 'xai') */
  readonly provider: string;
  /** Model identifier (e.g., 'claude-3-5-sonnet-20241022') */
  readonly model: string;
  /** Model version/snapshot if available */
  readonly modelVersion: string;
}

export class DeterministicMockProducer implements ModelProducer {
  readonly provider = 'local';
  readonly model = 'mock-producer';
  readonly modelVersion = 'v0.1';

  async produce(atom: AtomSpec, context: ProducerContext): Promise<ProducerResult> {
    const attemptNumber = 1;
    const startedAt = new Date().toISOString();
    const artifact: ProducedArtifact = {
      artifactHash: createHash('sha256').update(JSON.stringify(context.artifacts)).digest('hex'),
      diffHash: createHash('sha256').update(JSON.stringify(context.failure ?? 'no-failure')).digest('hex'),
      filesChanged: context.artifacts,
      declaredArtifacts: context.artifacts,
    };

    return {
      atom_id: atom.atom.id,
      spec_hash: computeSpecHash(atom),
      attempt_number: attemptNumber,
      producer_id: 'deterministic-mock',
      provider: this.provider,
      model: this.model,
      model_version: this.modelVersion,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      declared_output_artifacts: context.artifacts,
      artifact,
      context: {
        artifacts: [...context.artifacts],
        failure: context.failure,
        priorConversation: [],
      },
      usage: {
        tokens: 0,
        cost: 0,
        costType: 'measured',
      },
      vendor_metadata: {
        vendor_request_id: null,
        response_id: null,
        model_snapshot: null,
        stop_reason: null,
      },
    };
  }
}

/**
 * Base class for real vendor producers.
 * Subclasses must implement the actual vendor API call.
 * UNKNOWN / UNAVAILABLE fields must remain explicit.
 */
export abstract class RealVendorProducer implements ModelProducer {
  abstract readonly provider: string;
  abstract readonly model: string;
  abstract readonly modelVersion: string;

  abstract produce(atom: AtomSpec, context: ProducerContext): Promise<ProducerResult>;

  /** Creates vendor_metadata with explicit UNKNOWN/UNAVAILABLE for missing fields. */
  protected createVendorMetadata(partial: Partial<ProducerResult['vendor_metadata']>): ProducerResult['vendor_metadata'] {
    return {
      vendor_request_id: partial.vendor_request_id ?? null,
      response_id: partial.response_id ?? null,
      model_snapshot: partial.model_snapshot ?? null,
      stop_reason: partial.stop_reason ?? null,
      ...partial,
    };
  }

  /** Creates usage with explicit costType for missing data. */
  protected createUsage(tokens: number, cost: number, costType: ProducerResult['usage']['costType']): ProducerResult['usage'] {
    return { tokens, cost, costType };
  }
}

/**
 * Anthropic producer — TEST HARNESS for v0.1.
 * REPLACE with real @anthropic-ai/sdk integration when available.
 * The real SDK does not currently expose a reliable pre-tool hook.
 */
export class AnthropicProducer extends RealVendorProducer {
  readonly provider = 'anthropic';
  readonly model = 'claude-3-5-sonnet-20241022';
  readonly modelVersion = '20241022';

  async produce(atom: AtomSpec, context: ProducerContext): Promise<ProducerResult> {
    const startedAt = new Date().toISOString();

    // SIMULATED - Replace with real Anthropic SDK call when available
    // This demonstrates the metadata structure a real producer would return
    const artifact: ProducedArtifact = {
      artifactHash: createHash('sha256').update(JSON.stringify(context.artifacts)).digest('hex'),
      diffHash: createHash('sha256').update(JSON.stringify(context.failure ?? 'no-failure')).digest('hex'),
      filesChanged: context.artifacts,
      declaredArtifacts: context.artifacts,
    };

    return {
      atom_id: atom.atom.id,
      spec_hash: computeSpecHash(atom),
      attempt_number: 1,
      producer_id: `anthropic-${randomUUID()}`,
      provider: this.provider,
      model: this.model,
      model_version: this.modelVersion,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      declared_output_artifacts: context.artifacts,
      artifact,
      context: {
        artifacts: [...context.artifacts],
        failure: context.failure,
        priorConversation: [],
      },
      usage: this.createUsage(0, 0, 'unavailable'),
      vendor_metadata: this.createVendorMetadata({
        vendor_request_id: `req_${randomUUID()}`,
        response_id: `resp_${randomUUID()}`,
        model_snapshot: this.modelVersion,
        stop_reason: 'end_turn',
      }),
    };
  }
}

/**
 * OpenAI producer — NOT_IMPLEMENTED in v0.1.
 */
export class OpenAIProducer extends RealVendorProducer {
  readonly provider = 'openai';
  readonly model = 'gpt-4o';
  readonly modelVersion = '2024-08-06';

  async produce(): Promise<ProducerResult> {
    throw new Error('OpenAIProducer not implemented in v0.1');
  }
}

/**
 * xAI producer — NOT_IMPLEMENTED in v0.1.
 */
export class XAIProducer extends RealVendorProducer {
  readonly provider = 'xai';
  readonly model = 'grok-2';
  readonly modelVersion = '2024-07';

  async produce(): Promise<ProducerResult> {
    throw new Error('XAIProducer not implemented in v0.1');
  }
}

/** Registry for model producers. */
export class ModelProducerRegistry {
  private readonly producers = new Map<string, ModelProducer>();

  register(producer: ModelProducer): void {
    const key = `${producer.provider}:${producer.model}`;
    if (this.producers.has(key)) {
      throw new Error(`Producer already registered: ${key}`);
    }
    this.producers.set(key, producer);
  }

  get(provider: string, model: string): ModelProducer | null {
    return this.producers.get(`${provider}:${model}`) ?? null;
  }

  list(): ModelProducer[] {
    return [...this.producers.values()];
  }
}

export const modelProducerRegistry = new ModelProducerRegistry();

// Register default mock producer
modelProducerRegistry.register(new DeterministicMockProducer());
// Register test harness producers (clearly marked)
modelProducerRegistry.register(new AnthropicProducer());