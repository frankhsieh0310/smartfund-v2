export type ChainStage = "UPSTREAM" | "MIDSTREAM" | "DOWNSTREAM" | "UNSPECIFIED";

export type IndustryNodeLevel = "SECTOR" | "INDUSTRY" | "SUB_INDUSTRY";

export interface IndustryNode {
  id: string;
  name: string;
  parentId?: string;
  level: IndustryNodeLevel;
}

export type EvidenceVerificationStatus =
  | "VERIFIED"
  | "PENDING_VERIFICATION"
  | "REJECTED";

export interface RelationshipEvidence {
  source: string;
  sourceReference: string;
  evidenceDate: string;
  firstConfirmed: string;
  lastConfirmed: string;
  verificationStatus: EvidenceVerificationStatus;
  confidence?: number;
}

type CompanyReference =
  | { companyId: string; assetId?: string }
  | { companyId?: string; assetId: string };

export type IndustryChainMembership = CompanyReference & {
  industryNodeId: string;
  chainStage: ChainStage;
  evidence: RelationshipEvidence[];
};
