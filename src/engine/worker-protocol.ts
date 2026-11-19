import type { WasmGraphPayload } from '../etl/build-graph.ts';
import type {
  CustomBBoxInput,
  ScenarioEvaluationRequest,
} from './chokepoint-engine.ts';
import type { QueryTelemetry } from './envelope.ts';

export type WorkerRequest =
  | {
      readonly type: 'boot';
      readonly id: number;
      readonly payload?: WasmGraphPayload;
      readonly payloadUrl?: string;
      readonly chunkSize?: number;
    }
  | {
      readonly type: 'queryRoute';
      readonly id: number;
      readonly fromCode: string;
      readonly toCode: string;
      readonly blockedPassageIds: readonly string[];
      readonly profile?: boolean;
    }
  | {
      readonly type: 'evaluateScenario';
      readonly id: number;
      readonly request: ScenarioEvaluationRequest;
    }
  | {
      readonly type: 'applyCustomBoxes';
      readonly id: number;
      readonly boxes: readonly CustomBBoxInput[];
      readonly limit?: number;
    }
  | {
      readonly type: 'runCustomCypher';
      readonly id: number;
      readonly cypher: string;
      readonly params?: Readonly<Record<string, unknown>> | null;
      readonly profile?: boolean;
    }
  | {
      readonly type: 'getMetadata';
      readonly id: number;
    }
  | {
      readonly type: 'getPorts';
      readonly id: number;
    }
  | {
      readonly type: 'dispose';
      readonly id: number;
    };

export type WorkerResponse =
  | {
      readonly type: 'result';
      readonly id: number;
      readonly data: unknown;
    }
  | {
      readonly type: 'error';
      readonly id: number;
      readonly message: string;
      readonly wasmTrap: boolean;
      readonly cypher: string | null;
      readonly telemetry: QueryTelemetry | null;
    };
