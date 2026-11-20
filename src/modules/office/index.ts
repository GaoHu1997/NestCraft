/** 办公工作区模块（UI-CR043-v1）。 */
export { OfficeFileTree, useOfficeVersion } from "./OfficeFileTree";
export { OfficeViewer, OfficeArtifacts, OfficeCloseGuard } from "./OfficeViewer";
export { loadSample, sampleKindFor } from "./office-samples";
export {
  officeFileList, officeNotify, st, requestOfficeClose, saveDraft, saveOfficeFile,
  currentOfficeContent, officeContentText, copyOfficeFile,
} from "./office-model";
export { seedOfficeSessionDemo } from "./office-demo";
export { ensureOfficeDemoProjects, ensureOfficeProjectSample, isOfficeDemoProject } from "./office-seed";
