/**
 * Ambient declarations for the After Effects ExtendScript DOM used by the builder.
 * Deliberately loose (`any`): the AE object model is dynamic and version-dependent, and
 * every capability that differs across versions is feature-detected at runtime.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
declare var app: any;
declare var $: any;
declare var File: any;
declare var Folder: any;
declare var ImportOptions: any;
declare var Shape: any;
declare var CompItem: any;
declare var FolderItem: any;
declare var FootageItem: any;
declare var BlendingMode: any;
declare var TrackMatteType: any;
declare var ParagraphJustification: any;
declare var KeyframeInterpolationType: any;
