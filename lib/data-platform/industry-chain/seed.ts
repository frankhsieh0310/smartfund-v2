import type {
  ChainStage,
  IndustryChainMembership,
  IndustryNode,
  RelationshipEvidence,
} from "./types.ts";

interface IndustryChainSeed {
  id: string;
  name: string;
  nodes: IndustryNode[];
  stageNodeIds: Record<ChainStage, string[]>;
  memberships: IndustryChainMembership[];
}

const evidence = (
  source: string,
  sourceReference: string,
): RelationshipEvidence => ({
  source,
  sourceReference,
  evidenceDate: "2026-08-16",
  firstConfirmed: "2026-08-16",
  lastConfirmed: "2026-08-16",
  verificationStatus: "PENDING_VERIFICATION",
});

export const taiwanSemiconductorIndustryChain = {
  id: "industry-chain:tw:semiconductor",
  name: "Taiwan Semiconductor Industry Chain",
  nodes: [
    { id: "industry:semiconductor", name: "Semiconductor", level: "INDUSTRY" },
    { id: "subindustry:semiconductor-ip-ic-design", name: "IP / IC Design", parentId: "industry:semiconductor", level: "SUB_INDUSTRY" },
    { id: "subindustry:ic-design", name: "IC Design", parentId: "industry:semiconductor", level: "SUB_INDUSTRY" },
    { id: "subindustry:ic-wafer-manufacturing", name: "IC / Wafer Manufacturing", parentId: "industry:semiconductor", level: "SUB_INDUSTRY" },
    { id: "subindustry:semiconductor-equipment", name: "Semiconductor Equipment", parentId: "industry:semiconductor", level: "SUB_INDUSTRY" },
    { id: "subindustry:photomask", name: "Photomask", parentId: "industry:semiconductor", level: "SUB_INDUSTRY" },
    { id: "subindustry:semiconductor-chemicals-materials", name: "Chemicals / Materials", parentId: "industry:semiconductor", level: "SUB_INDUSTRY" },
    { id: "subindustry:semiconductor-packaging-testing", name: "Packaging / Testing", parentId: "industry:semiconductor", level: "SUB_INDUSTRY" },
    { id: "subindustry:semiconductor-substrate", name: "Substrate", parentId: "industry:semiconductor", level: "SUB_INDUSTRY" },
    { id: "subindustry:lead-frame", name: "Lead Frame", parentId: "industry:semiconductor", level: "SUB_INDUSTRY" },
    { id: "subindustry:ic-module", name: "IC Module", parentId: "industry:semiconductor", level: "SUB_INDUSTRY" },
    { id: "subindustry:ic-distribution", name: "IC Distribution", parentId: "industry:semiconductor", level: "SUB_INDUSTRY" },
  ],
  stageNodeIds: {
    UPSTREAM: ["subindustry:semiconductor-ip-ic-design", "subindustry:ic-design"],
    MIDSTREAM: ["subindustry:ic-wafer-manufacturing", "subindustry:semiconductor-equipment", "subindustry:photomask", "subindustry:semiconductor-chemicals-materials"],
    DOWNSTREAM: ["subindustry:semiconductor-packaging-testing", "subindustry:semiconductor-equipment", "subindustry:semiconductor-substrate", "subindustry:lead-frame", "subindustry:ic-module", "subindustry:ic-distribution"],
  },
  memberships: [
    { companyId: "company:tw:mediatek", industryNodeId: "subindustry:ic-design", chainStage: "UPSTREAM", evidence: [evidence("MediaTek", "https://www.mediatek.com/about-us")] },
    { companyId: "company:tw:tsmc", industryNodeId: "subindustry:ic-wafer-manufacturing", chainStage: "MIDSTREAM", evidence: [evidence("TSMC", "https://www.tsmc.com/english/dedicatedFoundry")] },
    { companyId: "company:tw:ase-technology", industryNodeId: "subindustry:semiconductor-packaging-testing", chainStage: "DOWNSTREAM", evidence: [evidence("ASE Technology Holding", "https://www.aseglobal.com/about-us/")] },
    { companyId: "company:tw:wpg-holdings", industryNodeId: "subindustry:ic-distribution", chainStage: "DOWNSTREAM", evidence: [evidence("WPG Holdings", "https://www.wpgholdings.com/about") ] },
  ],
} satisfies IndustryChainSeed;

export const aiIndustryChain = {
  id: "industry-chain:global:ai",
  name: "AI Industry / Theme Chain",
  nodes: [
    { id: "industry:artificial-intelligence", name: "Artificial Intelligence", level: "INDUSTRY" },
    { id: "subindustry:ai-computing-chips", name: "Computing Chips", parentId: "industry:artificial-intelligence", level: "SUB_INDUSTRY" },
    { id: "subindustry:ai-servers-infrastructure", name: "AI Servers / Computing Infrastructure", parentId: "industry:artificial-intelligence", level: "SUB_INDUSTRY" },
    { id: "subindustry:ai-cloud-platform", name: "Cloud Platform", parentId: "industry:artificial-intelligence", level: "SUB_INDUSTRY" },
    { id: "subindustry:ai-data-processing", name: "Data Processing", parentId: "industry:artificial-intelligence", level: "SUB_INDUSTRY" },
    { id: "subindustry:machine-learning", name: "Machine Learning", parentId: "industry:artificial-intelligence", level: "SUB_INDUSTRY" },
    { id: "subindustry:computer-vision", name: "Computer Vision", parentId: "industry:artificial-intelligence", level: "SUB_INDUSTRY" },
    { id: "subindustry:nlp-generative-ai", name: "NLP / Generative AI", parentId: "industry:artificial-intelligence", level: "SUB_INDUSTRY" },
  ],
  stageNodeIds: {
    UPSTREAM: ["subindustry:ai-computing-chips", "subindustry:machine-learning"],
    MIDSTREAM: ["subindustry:ai-servers-infrastructure", "subindustry:ai-cloud-platform", "subindustry:ai-data-processing"],
    DOWNSTREAM: ["subindustry:computer-vision", "subindustry:nlp-generative-ai"],
  },
  memberships: [
    { companyId: "company:us:nvidia", industryNodeId: "subindustry:ai-computing-chips", chainStage: "UPSTREAM", evidence: [evidence("NVIDIA", "https://www.nvidia.com/en-us/data-center/")] },
    { companyId: "company:us:nvidia", industryNodeId: "subindustry:ai-servers-infrastructure", chainStage: "MIDSTREAM", evidence: [evidence("NVIDIA", "https://www.nvidia.com/en-us/data-center/")] },
    { companyId: "company:us:microsoft", industryNodeId: "subindustry:ai-cloud-platform", chainStage: "MIDSTREAM", evidence: [evidence("Microsoft Azure", "https://azure.microsoft.com/en-us/solutions/ai")] },
    { companyId: "company:us:microsoft", industryNodeId: "subindustry:nlp-generative-ai", chainStage: "DOWNSTREAM", evidence: [evidence("Microsoft Azure", "https://azure.microsoft.com/en-us/products/ai-services/openai-service")] },
    { companyId: "company:us:alphabet", industryNodeId: "subindustry:ai-cloud-platform", chainStage: "MIDSTREAM", evidence: [evidence("Google Cloud", "https://cloud.google.com/products/ai")] },
    { companyId: "company:us:alphabet", industryNodeId: "subindustry:machine-learning", chainStage: "UPSTREAM", evidence: [evidence("Google Cloud Vertex AI", "https://cloud.google.com/vertex-ai")] },
    { companyId: "company:us:alphabet", industryNodeId: "subindustry:computer-vision", chainStage: "DOWNSTREAM", evidence: [evidence("Google Cloud Vision AI", "https://cloud.google.com/vision") ] },
    { companyId: "company:us:alphabet", industryNodeId: "subindustry:nlp-generative-ai", chainStage: "DOWNSTREAM", evidence: [evidence("Google Cloud Vertex AI", "https://cloud.google.com/vertex-ai/generative-ai") ] },
    { companyId: "company:us:palantir", industryNodeId: "subindustry:ai-data-processing", chainStage: "MIDSTREAM", evidence: [evidence("Palantir", "https://www.palantir.com/platforms/aip/")] },
  ],
} satisfies IndustryChainSeed;

export const industryChainSeeds = [
  taiwanSemiconductorIndustryChain,
  aiIndustryChain,
] satisfies IndustryChainSeed[];
