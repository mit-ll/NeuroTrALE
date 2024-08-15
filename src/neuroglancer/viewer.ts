/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * 
 * @modifcations
 * MIT modified this file. For more information see the NOTICES.txt file
 */

import debounce from 'lodash/debounce';
import {CapacitySpecification, ChunkManager, ChunkQueueManager, FrameNumberCounter} from 'neuroglancer/chunk_manager/frontend';
import {defaultCredentialsManager} from 'neuroglancer/credentials_provider/default_manager';
import {InputEventBindings as DataPanelInputEventBindings} from 'neuroglancer/data_panel_layout';
import {DataSourceProvider} from 'neuroglancer/datasource';
import {getDefaultDataSourceProvider} from 'neuroglancer/datasource/default_provider';
import {DisplayContext} from 'neuroglancer/display_context';
import {InputEventBindingHelpDialog} from 'neuroglancer/help/input_event_bindings';
import {allRenderLayerRoles, LayerManager, LayerSelectedValues, MouseSelectionState, RenderLayerRole, SelectedLayerState} from 'neuroglancer/layer';
import {LayerDialog} from 'neuroglancer/layer_dialog';
import {RootLayoutContainer} from 'neuroglancer/layer_groups_layout';
import {TopLevelLayerListSpecification, ManagedUserLayerWithSpecification} from 'neuroglancer/layer_specification';
import {NavigationState, Pose} from 'neuroglancer/navigation_state';
import {overlaysOpen} from 'neuroglancer/overlay';
import {StatusMessage} from 'neuroglancer/status';
import {ElementVisibilityFromTrackableBoolean, TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {makeDerivedWatchableValue, TrackableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {ContextMenu} from 'neuroglancer/ui/context_menu';
import {DragResizablePanel} from 'neuroglancer/ui/drag_resize';
import {LayerInfoPanelContainer} from 'neuroglancer/ui/layer_side_panel';
import {MouseSelectionStateTooltipManager} from 'neuroglancer/ui/mouse_selection_state_tooltip';
import {setupPositionDropHandlers} from 'neuroglancer/ui/position_drag_and_drop';
import {StateEditorDialog} from 'neuroglancer/ui/state_editor';
import {StatisticsDisplayState, StatisticsPanel} from 'neuroglancer/ui/statistics';
import {AutomaticallyFocusedElement} from 'neuroglancer/util/automatic_focus';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {registerActionListener} from 'neuroglancer/util/event_action_map';
import {vec3} from 'neuroglancer/util/geom';
import {EventActionMap, KeyboardEventBinder} from 'neuroglancer/util/keyboard_bindings';
import {NullarySignal} from 'neuroglancer/util/signal';
import {CompoundTrackable} from 'neuroglancer/util/trackable';
import {ViewerState, VisibilityPrioritySpecification} from 'neuroglancer/viewer_state';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {GL} from 'neuroglancer/webgl/context';
import {AnnotationToolStatusWidget} from 'neuroglancer/widget/annotation_tool_status';
import {NumberInputWidget} from 'neuroglancer/widget/number_input_widget';
import {MousePositionWidget, PositionWidget, VoxelSizeWidget} from 'neuroglancer/widget/position_widget';
import {TrackableScaleBarOptions} from 'neuroglancer/widget/scale_bar';
import {makeTextIconButton} from 'neuroglancer/widget/text_icon_button';
import {RPC} from 'neuroglancer/worker_rpc';
import { AnnotationUserLayer } from './annotation/user_layer';
import { TwoStepAnnotationTool } from 'neuroglancer/ui/annotations.ts';
import { TreeInfoPanelContainer } from 'neuroglancer/dir_tree/tree_layer';
import { PerspectiveViewAnnotationLayer } from './annotation/renderlayer';

declare var NEUROGLANCER_OVERRIDE_DEFAULT_VIEWER_OPTIONS: any

require('./viewer.css');
require('neuroglancer/noselect.css');
require('neuroglancer/ui/button.css');

export class DataManagementContext extends RefCounted {
  worker = new Worker('chunk_worker.bundle.js');
  chunkQueueManager = this.registerDisposer(
      new ChunkQueueManager(new RPC(this.worker), this.gl, this.frameNumberCounter, {
        gpuMemory: new CapacitySpecification({defaultItemLimit: 1e6, defaultSizeLimit: 1e9}),
        systemMemory: new CapacitySpecification({defaultItemLimit: 1e7, defaultSizeLimit: 2e9}),
        download: new CapacitySpecification(
            {defaultItemLimit: 32, defaultSizeLimit: Number.POSITIVE_INFINITY}),
        compute: new CapacitySpecification({defaultItemLimit: 128, defaultSizeLimit: 5e8}),
      }));
  chunkManager = this.registerDisposer(new ChunkManager(this.chunkQueueManager));

  get rpc(): RPC {
    return this.chunkQueueManager.rpc!;
  }

  constructor(public gl: GL, public frameNumberCounter: FrameNumberCounter) {
    super();
    this.chunkQueueManager.registerDisposer(() => this.worker.terminate());
  }
}

export class InputEventBindings extends DataPanelInputEventBindings {
  global = new EventActionMap();
}

const viewerUiControlOptionKeys: (keyof ViewerUIControlConfiguration)[] = [
  'showHelpButton',
  'showEditStateButton',
  'showLayerPanel',
  'showLocation',
  'showAnnotationToolStatus',
];

const viewerOptionKeys: (keyof ViewerUIOptions)[] =
    ['showUIControls', 'showPanelBorders', ...viewerUiControlOptionKeys];

export class ViewerUIControlConfiguration {
  showHelpButton = new TrackableBoolean(true);
  showEditStateButton = new TrackableBoolean(true);
  showLayerPanel = new TrackableBoolean(true);
  showLocation = new TrackableBoolean(true);
  showAnnotationToolStatus = new TrackableBoolean(true);
}

export class ViewerUIConfiguration extends ViewerUIControlConfiguration {
  /**
   * If set to false, all UI controls (controlled individually by the options below) are disabled.
   */
  showUIControls = new TrackableBoolean(true);
  showPanelBorders = new TrackableBoolean(true);
}

function setViewerUiConfiguration(
    config: ViewerUIConfiguration, options: Partial<ViewerUIOptions>) {
  for (const key of viewerOptionKeys) {
    const value = options[key];
    if (value !== undefined) {
      config[key].value = value;
    }
  }
}

interface ViewerUIOptions {
  showUIControls: boolean;
  showHelpButton: boolean;
  showEditStateButton: boolean;
  showLayerPanel: boolean;
  showLocation: boolean;
  showPanelBorders: boolean;
  showAnnotationToolStatus: boolean;
}

export interface ViewerOptions extends ViewerUIOptions, VisibilityPrioritySpecification {
  dataContext: Owned<DataManagementContext>;
  element: HTMLElement;
  dataSourceProvider: Borrowed<DataSourceProvider>;
  uiConfiguration: ViewerUIConfiguration;
  showLayerDialog: boolean;
  inputEventBindings: InputEventBindings;
  resetStateWhenEmpty: boolean;
}

const defaultViewerOptions = "undefined" !== typeof NEUROGLANCER_OVERRIDE_DEFAULT_VIEWER_OPTIONS ?
  NEUROGLANCER_OVERRIDE_DEFAULT_VIEWER_OPTIONS : {
    showLayerDialog: true,
    resetStateWhenEmpty: true,
  };

function makeViewerContextMenu(viewer: Viewer) {
  const menu = new ContextMenu();
  const {element} = menu;
  element.classList.add('neuroglancer-viewer-context-menu');
  const addLimitWidget = (label: string, limit: TrackableValue<number>) => {
    const widget = menu.registerDisposer(new NumberInputWidget(limit, {label}));
    widget.element.classList.add('neuroglancer-viewer-context-menu-limit-widget');
    element.appendChild(widget.element);
  };
  addLimitWidget('GPU memory limit', viewer.chunkQueueManager.capacities.gpuMemory.sizeLimit);
  addLimitWidget('System memory limit', viewer.chunkQueueManager.capacities.systemMemory.sizeLimit);
  addLimitWidget(
      'Concurrent chunk requests', viewer.chunkQueueManager.capacities.download.itemLimit);

  const addCheckbox = (label: string, value: TrackableBoolean) => {
    const labelElement = document.createElement('label');
    labelElement.textContent = label;
    const checkbox = menu.registerDisposer(new TrackableBooleanCheckbox(value));
    labelElement.appendChild(checkbox.element);
    element.appendChild(labelElement);
  };
  addCheckbox('Show axis lines', viewer.showAxisLines);
  addCheckbox('Show scale bar', viewer.showScaleBar);
  addCheckbox('Show cross sections in 3-d', viewer.showPerspectiveSliceViews);
  addCheckbox('Show default annotations', viewer.showDefaultAnnotations);
  addCheckbox('Show chunk statistics', viewer.statisticsDisplayState.visible);
  return menu;
}

export class Viewer extends RefCounted implements ViewerState {
  navigationState = this.registerDisposer(new NavigationState());
  perspectiveNavigationState = new NavigationState(new Pose(this.navigationState.position), 1);
  mouseState = new MouseSelectionState();
  layerManager = this.registerDisposer(new LayerManager());
  selectedLayer = this.registerDisposer(new SelectedLayerState(this.layerManager.addRef()));
  showAxisLines = new TrackableBoolean(true, true);
  showScaleBar = new TrackableBoolean(true, true);
  showPerspectiveSliceViews = new TrackableBoolean(true, true);
  visibleLayerRoles = allRenderLayerRoles();
  showDefaultAnnotations = new TrackableBoolean(true, true);
  crossSectionBackgroundColor = new TrackableRGB(vec3.fromValues(0.5, 0.5, 0.5));
  perspectiveViewBackgroundColor = new TrackableRGB(vec3.fromValues(0, 0, 0));
  scaleBarOptions = new TrackableScaleBarOptions();
  contextMenu: ContextMenu;
  statisticsDisplayState = new StatisticsDisplayState();
  currentAnnotationZIndex:null|number = null;
  discardStateSaveRequests:boolean = false;
  loadingContourCount:number = 0;
  loadingCentroidCount:number = 0;
  loadingAxonCount:number = 0;
  abortControllerAxon:AbortController|null = null;
  abortControllerContour:AbortController|null = null;
  abortControllerCentroid:AbortController|null = null;
  desiredAnnotationCoordinates:vec3 = vec3.fromValues(0, 0, 0);
  annotationTreeView:TreeInfoPanelContainer|null = null;

  layerSelectedValues =
      this.registerDisposer(new LayerSelectedValues(this.layerManager, this.mouseState));
  resetInitiated = new NullarySignal();

  get chunkManager() {
    return this.dataContext.chunkManager;
  }
  get chunkQueueManager() {
    return this.dataContext.chunkQueueManager;
  }

  layerSpecification: TopLevelLayerListSpecification;
  layout: RootLayoutContainer;

  state = new CompoundTrackable();

  dataContext: Owned<DataManagementContext>;
  visibility: WatchableVisibilityPriority;
  inputEventBindings: InputEventBindings;
  element: HTMLElement;
  dataSourceProvider: Borrowed<DataSourceProvider>;

  uiConfiguration: ViewerUIConfiguration;

  private makeUiControlVisibilityState(key: keyof ViewerUIOptions) {
    const showUIControls = this.uiConfiguration.showUIControls;
    const option = this.uiConfiguration[key];
    return this.registerDisposer(
        makeDerivedWatchableValue((a, b) => a && b, showUIControls, option));
  }

  /**
   * Logical and of each of the above values with the value of showUIControls.
   */
  uiControlVisibility:
      {[key in keyof ViewerUIControlConfiguration]: WatchableValueInterface<boolean>} = <any>{};

  showLayerDialog: boolean;
  resetStateWhenEmpty: boolean;

  get inputEventMap() {
    return this.inputEventBindings.global;
  }

  visible = true;

  constructor(public display: DisplayContext, options: Partial<ViewerOptions> = {}) {
    super();

    const {
      dataContext = new DataManagementContext(display.gl, display),
      visibility = new WatchableVisibilityPriority(WatchableVisibilityPriority.VISIBLE),
      inputEventBindings = {
        global: new EventActionMap(),
        sliceView: new EventActionMap(),
        perspectiveView: new EventActionMap(),
      },
      element = display.makeCanvasOverlayElement(),
      dataSourceProvider =
          getDefaultDataSourceProvider({credentialsManager: defaultCredentialsManager}),
      uiConfiguration = new ViewerUIConfiguration(),
    } = options;
    this.visibility = visibility;
    this.inputEventBindings = inputEventBindings;
    this.element = element;
    this.dataSourceProvider = dataSourceProvider;
    this.uiConfiguration = uiConfiguration;

    this.registerDisposer(() => removeFromParent(this.element));

    this.dataContext = this.registerDisposer(dataContext);

    setViewerUiConfiguration(uiConfiguration, options);

    const optionsWithDefaults = {...defaultViewerOptions, ...options};
    const {
      resetStateWhenEmpty,
      showLayerDialog,
    } = optionsWithDefaults;

    for (const key of viewerUiControlOptionKeys) {
      this.uiControlVisibility[key] = this.makeUiControlVisibilityState(key);
    }
    this.registerDisposer(this.uiConfiguration.showPanelBorders.changed.add(() => {
      this.updateShowBorders();
    }));

    this.showLayerDialog = showLayerDialog;
    this.resetStateWhenEmpty = resetStateWhenEmpty;

    this.layerSpecification = new TopLevelLayerListSpecification(
        this.dataSourceProvider, this.layerManager, this.chunkManager, this.layerSelectedValues,
        this.navigationState.voxelSize);

    this.registerDisposer(display.updateStarted.add(() => {
      this.onUpdateDisplay();
    }));

    this.showDefaultAnnotations.changed.add(() => {
      if (this.showDefaultAnnotations.value) {
        this.visibleLayerRoles.add(RenderLayerRole.DEFAULT_ANNOTATION);
      } else {
        this.visibleLayerRoles.delete(RenderLayerRole.DEFAULT_ANNOTATION);
      }
    });

    const {state} = this;
    state.add('layers', this.layerSpecification);
    state.add('navigation', this.navigationState);
    state.add('showAxisLines', this.showAxisLines);
    state.add('showScaleBar', this.showScaleBar);
    state.add('showDefaultAnnotations', this.showDefaultAnnotations);

    state.add('perspectiveOrientation', this.perspectiveNavigationState.pose.orientation);
    state.add('perspectiveZoom', this.perspectiveNavigationState.zoomFactor);
    state.add('showSlices', this.showPerspectiveSliceViews);
    state.add('gpuMemoryLimit', this.dataContext.chunkQueueManager.capacities.gpuMemory.sizeLimit);
    state.add(
        'systemMemoryLimit', this.dataContext.chunkQueueManager.capacities.systemMemory.sizeLimit);
    state.add(
        'concurrentDownloads', this.dataContext.chunkQueueManager.capacities.download.itemLimit);
    state.add('selectedLayer', this.selectedLayer);
    state.add('crossSectionBackgroundColor', this.crossSectionBackgroundColor);
    state.add('perspectiveViewBackgroundColor', this.perspectiveViewBackgroundColor);

    this.registerDisposer(this.navigationState.changed.add(() => {
      this.handleNavigationStateChanged();
    }));

    this.layerManager.initializePosition(this.navigationState.position);

    this.registerDisposer(
        this.layerSpecification.voxelCoordinatesSet.add((voxelCoordinates: vec3) => {
          this.navigationState.position.setVoxelCoordinates(voxelCoordinates);
        }));

    this.registerDisposer(
        this.layerSpecification.spatialCoordinatesSet.add((spatialCoordinates: vec3) => {
          const {position} = this.navigationState;
          vec3.copy(position.spatialCoordinates, spatialCoordinates);
          position.markSpatialCoordinatesChanged();
        }));


    // Debounce this call to ensure that a transient state does not result in the layer dialog being
    // shown.
    const maybeResetState = this.registerCancellable(debounce(() => {
      if (!this.wasDisposed && this.layerManager.managedLayers.length === 0 &&
          this.resetStateWhenEmpty) {
        // No layers, reset state.
        this.navigationState.reset();
        this.perspectiveNavigationState.pose.orientation.reset();
        this.perspectiveNavigationState.zoomFactor.reset();
        this.resetInitiated.dispatch();
        if (!overlaysOpen && this.showLayerDialog && this.visibility.visible) {
          new LayerDialog(this.layerSpecification);
        }
      }
    }));
    this.layerManager.layersChanged.add(maybeResetState);
    maybeResetState();

    this.registerDisposer(this.dataContext.chunkQueueManager.visibleChunksChanged.add(() => {
      this.layerSelectedValues.handleLayerChange();
    }));

    this.registerDisposer(this.dataContext.chunkQueueManager.visibleChunksChanged.add(() => {
      if (this.visible) {
        display.scheduleRedraw();
      }
    }));

    this.makeUI();
    this.updateShowBorders();

    state.add('layout', this.layout);


    state.add('statistics', this.statisticsDisplayState);

    this.registerActionListeners();
    this.registerEventActionBindings();

    this.registerDisposer(setupPositionDropHandlers(element, this.navigationState.position));

    this.registerDisposer(new MouseSelectionStateTooltipManager(
        this.mouseState, this.layerManager, this.navigationState.voxelSize));
  }

  private updateShowBorders() {
    const {element} = this;
    const className = 'neuroglancer-show-panel-borders';
    if (this.uiConfiguration.showPanelBorders.value) {
      element.classList.add(className);
    } else {
      element.classList.remove(className);
    }
  }

  private makeUI() {
    const gridContainer = this.element;
    gridContainer.classList.add('neuroglancer-viewer');
    gridContainer.classList.add('neuroglancer-noselect');
    gridContainer.style.display = 'flex';
    gridContainer.style.flexDirection = 'column';

    const topRow = document.createElement('div');
    topRow.title = 'Right click for settings';
    topRow.classList.add('neuroglancer-viewer-top-row');
    const contextMenu = this.contextMenu = this.registerDisposer(makeViewerContextMenu(this));
    contextMenu.registerParent(topRow);
    topRow.style.display = 'flex';
    topRow.style.flexDirection = 'row';
    topRow.style.alignItems = 'stretch';

    const voxelSizeWidget = this.registerDisposer(
        new VoxelSizeWidget(document.createElement('div'), this.navigationState.voxelSize));
    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        this.uiControlVisibility.showLocation, voxelSizeWidget.element));
    topRow.appendChild(voxelSizeWidget.element);

    const positionWidget = this.registerDisposer(new PositionWidget(this.navigationState.position));
    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        this.uiControlVisibility.showLocation, positionWidget.element));
    topRow.appendChild(positionWidget.element);

    const mousePositionWidget = this.registerDisposer(new MousePositionWidget(
        document.createElement('div'), this.mouseState, this.navigationState.voxelSize));
    mousePositionWidget.element.style.flex = '1';
    mousePositionWidget.element.style.alignSelf = 'center';
    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        this.uiControlVisibility.showLocation, mousePositionWidget.element));
    topRow.appendChild(mousePositionWidget.element);

    const annotationToolStatus =
        this.registerDisposer(new AnnotationToolStatusWidget(this.selectedLayer));
    topRow.appendChild(annotationToolStatus.element);
    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        this.uiControlVisibility.showAnnotationToolStatus, annotationToolStatus.element));

    {
      const button = makeTextIconButton('{}', 'Edit JSON state');
      this.registerEventListener(button, 'click', () => {
        this.editJsonState();
      });
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showEditStateButton, button));
      topRow.appendChild(button);
    }


    {
      const button = makeTextIconButton('?', 'Help');
      this.registerEventListener(button, 'click', () => {
        this.showHelpDialog();
      });
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showHelpButton, button));
      topRow.appendChild(button);
    }

    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        makeDerivedWatchableValue(
            (...values: boolean[]) => values.reduce((a, b) => a || b, false),
            this.uiControlVisibility.showHelpButton, this.uiControlVisibility.showEditStateButton,
            this.uiControlVisibility.showLocation,
            this.uiControlVisibility.showAnnotationToolStatus),
        topRow));

    gridContainer.appendChild(topRow);

    const layoutAndSidePanel = document.createElement('div');
    layoutAndSidePanel.style.display = 'flex';
    layoutAndSidePanel.style.flex = '1';
    layoutAndSidePanel.style.flexDirection = 'row';

    const treeInfoPanel = new TreeInfoPanelContainer();
    this.annotationTreeView = treeInfoPanel;

    // TODO Load this from the jstree CSS file.
    let styles = `.jstree a { color: white; font-weight: bold; font-family: Arial, Verdana, sans-serif; font-size: 12px; }`;
    let styleSheet = document.createElement("style");
    styleSheet.type = "text/css";
    styleSheet.innerText = styles;
    document.head.appendChild(styleSheet);

    layoutAndSidePanel.appendChild(treeInfoPanel.element);

    this.layout = this.registerDisposer(new RootLayoutContainer(this, '4panel'));
    layoutAndSidePanel.appendChild(this.layout.element);
    const layerInfoPanel =
        this.registerDisposer(new LayerInfoPanelContainer(this.selectedLayer.addRef()));
    layoutAndSidePanel.appendChild(layerInfoPanel.element);
    const self = this;
    layerInfoPanel.registerDisposer(new DragResizablePanel(
        layerInfoPanel.element, {
          changed: self.selectedLayer.changed,
          get value() {
            return self.selectedLayer.visible;
          },
          set value(visible: boolean) {
            self.selectedLayer.visible = visible;
          }
        },
        this.selectedLayer.size, 'horizontal', 290));

    gridContainer.appendChild(layoutAndSidePanel);

    const statisticsPanel = this.registerDisposer(
        new StatisticsPanel(this.chunkQueueManager, this.statisticsDisplayState));
    gridContainer.appendChild(statisticsPanel.element);
    statisticsPanel.registerDisposer(new DragResizablePanel(
        statisticsPanel.element, this.statisticsDisplayState.visible,
        this.statisticsDisplayState.size, 'vertical'));

    const updateVisibility = () => {
      const shouldBeVisible = this.visibility.visible;
      if (shouldBeVisible !== this.visible) {
        gridContainer.style.visibility = shouldBeVisible ? 'inherit' : 'hidden';
        this.visible = shouldBeVisible;
      }
    };
    updateVisibility();
    this.registerDisposer(this.visibility.changed.add(updateVisibility));
  }

  /**
   * Called once by the constructor to set up event handlers.
   */
  private registerEventActionBindings() {
    const {element} = this;
    this.registerDisposer(new KeyboardEventBinder(element, this.inputEventMap));
    this.registerDisposer(new AutomaticallyFocusedElement(element));
  }

  bindAction(action: string, handler: () => void) {
    this.registerDisposer(registerActionListener(this.element, action, handler));
  }

  /**
   * Called once by the constructor to register the action listeners.
   */
  private registerActionListeners() {
    for (const action of ['recolor', 'clear-segments', ]) {
      this.bindAction(action, () => {
        this.layerManager.invokeAction(action);
      });
    }

    for (const action of ['select']) {
      this.bindAction(action, () => {
        this.mouseState.updateUnconditionally();
        this.layerManager.invokeAction(action);
      });
    }

    this.bindAction('set-annotation-block-coordinates', () => {
      this.navigationState.voxelSize.voxelFromSpatial(this.desiredAnnotationCoordinates, this.mouseState.position);

      this.desiredAnnotationCoordinates[0] = Math.floor(this.desiredAnnotationCoordinates[0]);
      this.desiredAnnotationCoordinates[1] = Math.floor(this.desiredAnnotationCoordinates[1]);
      this.desiredAnnotationCoordinates[2] = Math.floor(this.desiredAnnotationCoordinates[2]);

      this.loadAnnotations();
    });

    this.bindAction('help', () => this.showHelpDialog());

    for (let i = 1; i <= 9; ++i) {
      this.bindAction(`toggle-layer-${i}`, () => {
        const layerIndex = i - 1;
        const layers = this.layerManager.managedLayers;
        if (layerIndex < layers.length) {
          let layer = layers[layerIndex];
          layer.setVisible(!layer.visible);
        }
      });
      this.bindAction(`select-layer-${i}`, () => {
        const layerIndex = i - 1;
        const layers = this.layerManager.managedLayers;
        if (layerIndex < layers.length) {
          const layer = layers[layerIndex];
          this.selectedLayer.layer = layer;
          this.selectedLayer.visible = true;
        }
      });

      this.bindAction(`switch-annotation-to-layer-${i}`, () => {
        if (!(this.selectedLayer.layer instanceof ManagedUserLayerWithSpecification) || !(this.selectedLayer.layer.layer instanceof AnnotationUserLayer)) {
          return;
        }

        const managedLayers = this.layerManager.managedLayers;
        if (managedLayers.length < i || !(managedLayers[i - 1].layer instanceof AnnotationUserLayer)) { // The layer to move the annotation to doesn't exist.
          return;
        }
        
        const layerToMoveTo = managedLayers[i - 1].layer;
        if (!(layerToMoveTo instanceof AnnotationUserLayer)) { // The layer to move to isn't an annotation layer.
          return;
        }
        
        const layerToMoveFrom = this.selectedLayer.layer.layer;
        const annotationToMove = layerToMoveFrom.selectedAnnotation.reference;

        if (!annotationToMove) { // No annotation is currently selected.
          return;
        }

        const managedLayer = managedLayers[i - 1];
        if (managedLayer instanceof ManagedUserLayerWithSpecification) {
          annotationToMove.value!.anntype = managedLayer.initialSpecification.anntype;
        }

        this.discardStateSaveRequests = true;
        layerToMoveTo.localAnnotations.add(annotationToMove.value!, true);
        //layerToMoveTo.localAnnotations.childAdded.dispatch(annotationToMove.value!);

        this.discardStateSaveRequests = false; // TODO Usage of this flag is awful.
        layerToMoveFrom.localAnnotations.delete(annotationToMove, false);
        //layerToMoveFrom.localAnnotations.childDeleted.dispatch(annotationToMove.id);

        layerToMoveTo.selectedAnnotation.value = {id: annotationToMove.id, partIndex: 0};

        this.selectedLayer.layer = managedLayers[i - 1];
        this.selectedLayer.changed.dispatch();
      });
    }

    this.bindAction('annotate', () => {
      const selectedLayer = this.selectedLayer.layer;
      if (selectedLayer === undefined) {
        StatusMessage.showTemporaryMessage('The annotate command requires a layer to be selected.');
        return;
      }
      const userLayer = selectedLayer.layer;
      if (userLayer === null || userLayer.tool.value === undefined) {
        StatusMessage.showTemporaryMessage(`The selected layer (${
            JSON.stringify(selectedLayer.name)}) does not have an active annotation tool.`);
        return;
      }
      userLayer.tool.value.trigger(this.mouseState);
    });

    this.bindAction('create-annotation-selection', () => {
      const selectedLayer = this.selectedLayer.layer;
      if (selectedLayer === undefined) {
        StatusMessage.showTemporaryMessage('The annotate command requires a layer to be selected.');
        return;
      }
      const userLayer = selectedLayer.layer;
      if (userLayer === null || userLayer.tool.value === undefined) {
        StatusMessage.showTemporaryMessage(`The selected layer (${
            JSON.stringify(selectedLayer.name)}) does not have an active annotation tool.`);
        return;
      }

      // TODO Casting to 'any' is bad here; why isn't typescript picking up on the TwoStepAnnotationTool cast?
      const tool:any = userLayer.tool.value;
      if (tool instanceof TwoStepAnnotationTool && tool.select == undefined) {
        StatusMessage.showTemporaryMessage('The selected annotation tool does not support region selection.');
        return;
      }
      tool.select(this.mouseState);
    });
    
    this.bindAction('delete-selection', () => {
      const selectedLayer = this.selectedLayer.layer;
      if (selectedLayer === undefined) {
        StatusMessage.showTemporaryMessage('The annotate command requires a layer to be selected.');
        return;
      }
      const userLayer = selectedLayer.layer;
      if (userLayer === null || userLayer.tool.value === undefined) {
        StatusMessage.showTemporaryMessage(`The selected layer (${
            JSON.stringify(selectedLayer.name)}) does not have an active annotation tool.`);
        return;
      }

      // TODO Casting to 'any' is bad here; why isn't typescript picking up on the TwoStepAnnotationTool cast?
      const tool:any = userLayer.tool.value;
      if (tool instanceof TwoStepAnnotationTool && tool.select == undefined) {
        StatusMessage.showTemporaryMessage('The selected annotation tool does not support region deleting.');
        return;
      }
      tool.deleteSelection();
    });

    this.bindAction('follow-annotation-forward', () => {
      const selectedLayer = this.selectedLayer.layer;
      if (selectedLayer === undefined) {
        StatusMessage.showTemporaryMessage('The annotate command requires a layer to be selected.');
        return;
      }
      const userLayer = selectedLayer.layer;
      if (userLayer === null || userLayer.tool.value === undefined) {
        StatusMessage.showTemporaryMessage(`The selected layer (${
            JSON.stringify(selectedLayer.name)}) does not have an active annotation tool.`);
        return;
      }

      // TODO Casting to 'any' is bad here; why isn't typescript picking up on the TwoStepAnnotationTool cast?
      const tool:any = userLayer.tool.value;
      if (tool instanceof TwoStepAnnotationTool && tool.select == undefined) {
        StatusMessage.showTemporaryMessage('The selected annotation tool does not support annotation following.');
        return;
      }
      tool.followAnnotation(this.navigationState, true);
    });

    this.bindAction('follow-annotation-backward', () => {
      const selectedLayer = this.selectedLayer.layer;
      if (selectedLayer === undefined) {
        StatusMessage.showTemporaryMessage('The annotate command requires a layer to be selected.');
        return;
      }
      const userLayer = selectedLayer.layer;
      if (userLayer === null || userLayer.tool.value === undefined) {
        StatusMessage.showTemporaryMessage(`The selected layer (${
            JSON.stringify(selectedLayer.name)}) does not have an active annotation tool.`);
        return;
      }

      // TODO Casting to 'any' is bad here; why isn't typescript picking up on the TwoStepAnnotationTool cast?
      const tool:any = userLayer.tool.value;
      if (tool instanceof TwoStepAnnotationTool && tool.select == undefined) {
        StatusMessage.showTemporaryMessage('The selected annotation tool does not support annotation following.');
        return;
      }
      tool.followAnnotation(this.navigationState, false);
    });   

    this.bindAction('toggle-control-points', () => {
      for (let i = 0; i < this.layerManager.managedLayers.length; ++i) {
        let layer = this.layerManager.managedLayers[i].layer;
        if (layer instanceof AnnotationUserLayer) {
          let annotationLayer = (<PerspectiveViewAnnotationLayer>layer.renderLayers[0]).base;
          annotationLayer.drawControlPoints = !annotationLayer.drawControlPoints;
        }
      }
    });

    this.bindAction('toggle-axis-lines', () => this.showAxisLines.toggle());
    this.bindAction('toggle-scale-bar', () => this.showScaleBar.toggle());
    this.bindAction('toggle-default-annotations', () => this.showDefaultAnnotations.toggle());
    this.bindAction('toggle-show-slices', () => this.showPerspectiveSliceViews.toggle());
    this.bindAction('toggle-show-statistics', () => this.showStatistics());
  }

  showHelpDialog() {
    const {inputEventBindings} = this;
    new InputEventBindingHelpDialog([
      ['Global', inputEventBindings.global],
      ['Slice View', inputEventBindings.sliceView],
      ['Perspective View', inputEventBindings.perspectiveView],
    ]);
  }

  editJsonState() {
    new StateEditorDialog(this);
  }

  showStatistics(value: boolean|undefined = undefined) {
    if (value === undefined) {
      value = !this.statisticsDisplayState.visible.value;
    }
    this.statisticsDisplayState.visible.value = value;
  }

  get gl() {
    return this.display.gl;
  }

  onUpdateDisplay() {
    if (this.visible) {
      this.dataContext.chunkQueueManager.chunkUpdateDeadline = null;
    }
  }

  private handleNavigationStateChanged() {
    if (this.visible) {
      let {chunkQueueManager} = this.dataContext;
      if (chunkQueueManager.chunkUpdateDeadline === null) {
        chunkQueueManager.chunkUpdateDeadline = Date.now() + 10;
      }

      // If the z index has changed, load the appropriate set of annotations.
      if (this.currentAnnotationZIndex !== this.perspectiveNavigationState.pose.position.spatialCoordinates[2]) {
        this.currentAnnotationZIndex = this.perspectiveNavigationState.pose.position.spatialCoordinates[2]
        this.loadAnnotations();
      }
    }
  }

  private loadAnnotations() {
    this.layerManager.layerSet.forEach(layer => {
      if (layer instanceof ManagedUserLayerWithSpecification && layer.sourceUrl && layer.sourceUrl.indexOf("precomputed://") != -1) {
        this.addContourAnnotationLayers(layer.sourceUrl);
        this.addCentroidAnnotationLayer(layer.sourceUrl);
        this.addAxonAnnotationLayer(layer.sourceUrl);

        this.annotationTreeView!.loadTree("http" + layer.sourceUrl.split("http")[1], this.layerManager, this.navigationState);
      }
    });
  }

  private constructAxonAnnotationUrl(precomputedUrl:string) {
    const xIndex = this.desiredAnnotationCoordinates[0];
    const yIndex = this.desiredAnnotationCoordinates[1];
    const zIndex = this.desiredAnnotationCoordinates[2];
    const jsonUrl = "http" + precomputedUrl.split("http")[1] + `/annotations/x${xIndex}y${yIndex}z${zIndex}/fibers.json`;

    return jsonUrl;
  }

  private addAxonAnnotationLayer(precomputedUrl:string) {
    const jsonUrl = this.constructAxonAnnotationUrl(precomputedUrl);

    let axonsExist = false;
    let managedLayers:any = this.layerManager.managedLayers;
    for (let i = 0; i < managedLayers.length; ++i) {
      if (managedLayers[i].sourceUrl == jsonUrl) {
        axonsExist = true;
      }
    }

    if (axonsExist) { // The Axons have already been loaded.
      return;
    }

    if (this.abortControllerAxon) {
      this.abortControllerAxon.abort();
      this.abortControllerAxon = null;
    }
    this.abortControllerAxon = new AbortController();
    ++this.loadingAxonCount;
    this.getAnnotationLayerData(jsonUrl, (fileData:any) => {
      --this.loadingAxonCount;
      // Check to make sure the user hasn't navigated away from the location of the original request.
      const currentJsonUrl = this.constructAxonAnnotationUrl(precomputedUrl);
      if (currentJsonUrl != jsonUrl) { // The data is no longer needed.
        return;
      }

      let annotations = fileData;
      let layers:any = {};

      for (let i = 0; i < annotations.length; ++i) {
        if (!layers[annotations[i].anntype]) {
          layers[annotations[i].anntype] = [];
        }

        layers[annotations[i].anntype].push(annotations[i]);
      }

      const outlineColors:any = [
        {"red": [1, 0, 0]},
        {"blue": [0, 0.5, 1]},
        {"green": [0, 0.9, 0]},
        {"teal": [0, 1, 1]},
        {"orange": [1, 0.7, 0]},
        {"purple": [1, 0, 1]},
        {"yellow": [1, 1, 0]}
      ];

      let colorIndex = 0;
      for (let cellType in layers) {
        const colorName = Object.keys(outlineColors[colorIndex])[0];
        const color = outlineColors[colorIndex][colorName];
        let layerBaseName = `axons-${cellType}`;
        let layerName = `${layerBaseName} (${colorName})`;

        let existingLayer = null;
        for (let i = 0; i < this.layerManager.managedLayers.length; ++i) {
          let layer = this.layerManager.managedLayers[i];
          if (layer.layer instanceof AnnotationUserLayer && layer.name.indexOf(layerBaseName) != -1) {
            existingLayer = layer;
            break;
          }
        };

        if (existingLayer) {
          layerName = existingLayer.name;
          this.layerManager.removeManagedLayer(existingLayer);
        }

        try {
          const layer = new ManagedUserLayerWithSpecification(layerName, {}, this.layerSpecification);
          this.layerSpecification.initializeLayerFromSpec(layer, {type: "annotation", annotations: layers[cellType], anntype: cellType});

          const annotationLayer = layer.layer;
          if (annotationLayer instanceof AnnotationUserLayer) {
            annotationLayer.annotationColor.value[0] = color[0];
            annotationLayer.annotationColor.value[1] = color[1];
            annotationLayer.annotationColor.value[2] = color[2];
            annotationLayer.annotationColor.changed.dispatch();

            annotationLayer.localAnnotations.changed.add(() => {
              this.saveAnnotationLayerData(annotationLayer.sourceUrl!);
            });

            annotationLayer.sourceUrl = jsonUrl;
            annotationLayer.annotationType = cellType;
          }

          layer.sourceUrl = jsonUrl;
          this.layerSpecification.add(layer);

          //colorIndex = (((colorIndex - 1) % outlineColors.length) + outlineColors.length) % outlineColors.length;
          colorIndex = (colorIndex + 1) % outlineColors.length;
        }
        catch {
          // TODO Refine this to be a modal popup.
          alert("Warning: axon data retrieved from the server is malformed; further actions taken may not be saved properly. Please contact the system administrator.");
        }
      }

    }, this.abortControllerAxon);
  }

  private constructCentroidAnnotationUrl(precomputedUrl:string) {
    const xIndex = this.desiredAnnotationCoordinates[0];
    const yIndex = this.desiredAnnotationCoordinates[1];
    const zIndex = this.desiredAnnotationCoordinates[2];
    const jsonUrl = "http" + precomputedUrl.split("http")[1] + `/annotations/x${xIndex}y${yIndex}z${zIndex}/centroids.json`;

    return jsonUrl;
  }

  private addCentroidAnnotationLayer(precomputedUrl:string) {
    const jsonUrl = this.constructCentroidAnnotationUrl(precomputedUrl);

    let centroidsExist = false;
    let managedLayers:any = this.layerManager.managedLayers;
    for (let i = 0; i < managedLayers.length; ++i) {
      if (managedLayers[i].sourceUrl == jsonUrl) {
        centroidsExist = true;
      }
    }

    if (centroidsExist) { // The centroids have already been loaded.
      return;
    }

    if (this.abortControllerCentroid) {
      this.abortControllerCentroid.abort();
      this.abortControllerCentroid = null;
    }
    this.abortControllerCentroid = new AbortController();
    ++this.loadingCentroidCount;
    this.getAnnotationLayerData(jsonUrl, (fileData:any) => {
      --this.loadingCentroidCount;

      // Check to make sure the user hasn't navigated away from the location of the original request.
      const currentJsonUrl = this.constructCentroidAnnotationUrl(precomputedUrl);
      if (currentJsonUrl != jsonUrl) { // The data is no longer needed.
        return;
      }

      let annotations = fileData;
      let layers:any = {};

      for (let i = 0; i < annotations.length; ++i) {
        if (!layers[annotations[i].anntype]) {
          layers[annotations[i].anntype] = [];
        }

        layers[annotations[i].anntype].push(annotations[i]);
      }

      const outlineColors:any = [
        {"red": [1, 0, 0]},
        {"blue": [0, 0.5, 1]},
        {"green": [0, 0.9, 0]},
        {"teal": [0, 1, 1]},
        {"orange": [1, 0.7, 0]},
        {"purple": [1, 0, 1]},
        {"yellow": [1, 1, 0]}
      ];

      let colorIndex = 0;
      for (let cellType in layers) {
        const colorName = Object.keys(outlineColors[colorIndex])[0];
        const color = outlineColors[colorIndex][colorName];
        let layerBaseName = `centroids-${cellType}`;
        let layerName = `${layerBaseName} (${colorName})`;

        let existingLayer = null;
        for (let i = 0; i < this.layerManager.managedLayers.length; ++i) {
          let layer = this.layerManager.managedLayers[i];
          if (layer.layer instanceof AnnotationUserLayer && layer.name.indexOf(layerBaseName) != -1) {
            existingLayer = layer;
            break;
          }
        };

        if (existingLayer) {
          layerName = existingLayer.name;
          this.layerManager.removeManagedLayer(existingLayer);
        }

        try {
          const layer = new ManagedUserLayerWithSpecification(layerName, {}, this.layerSpecification);
          this.layerSpecification.initializeLayerFromSpec(layer, {type: "annotation", annotations: layers[cellType], anntype: cellType});

          const annotationLayer = layer.layer;
          if (annotationLayer instanceof AnnotationUserLayer) {
            annotationLayer.annotationColor.value[0] = color[0];
            annotationLayer.annotationColor.value[1] = color[1];
            annotationLayer.annotationColor.value[2] = color[2];
            annotationLayer.annotationColor.changed.dispatch();

            annotationLayer.localAnnotations.changed.add(() => {
              this.saveAnnotationLayerData(annotationLayer.sourceUrl!);
            });

            annotationLayer.sourceUrl = jsonUrl;
            annotationLayer.annotationType = cellType;
          }

          layer.sourceUrl = jsonUrl;
          this.layerSpecification.add(layer);

          //colorIndex = (((colorIndex - 1) % outlineColors.length) + outlineColors.length) % outlineColors.length;
          colorIndex = (colorIndex + 1) % outlineColors.length;
        }
        catch {
          // TODO Refine this to be a modal popup.
          alert("Warning: centroid data retrieved from the server is malformed; further actions taken may not be saved properly. Please contact the system administrator.");
        }
      }
    }, this.abortControllerCentroid);
  }

  private constructContourAnnotationUrl(precomputedUrl:string) {
    const xIndex = this.desiredAnnotationCoordinates[0];
    const yIndex = this.desiredAnnotationCoordinates[1];
    const zIndex = this.desiredAnnotationCoordinates[2];
    const zIndexPadded = ("0000" + Math.floor(this.currentAnnotationZIndex!)).slice(-4); // Zero pad.
    const jsonUrl = "http" + precomputedUrl.split("http")[1] + `/annotations/x${xIndex}y${yIndex}z${zIndex}/z-${zIndexPadded}.json`;

    return jsonUrl;
  }

  private addContourAnnotationLayers(precomputedUrl:string) {
    const jsonUrl = this.constructContourAnnotationUrl(precomputedUrl);

    if (this.abortControllerContour) {
      this.abortControllerContour.abort();
      this.abortControllerContour = null;
    }
    this.abortControllerContour = new AbortController();
    ++this.loadingContourCount;
    this.getAnnotationLayerData(jsonUrl, (fileData:any) => {
      --this.loadingContourCount;

      // Check to make sure the user hasn't navigated away from the location of the original request.
      const currentJsonUrl = this.constructContourAnnotationUrl(precomputedUrl);
      if (currentJsonUrl != jsonUrl) { // The data is no longer needed.
        return;
      }

      let annotations = fileData;
      let layers:any = {};

      for (let i = 0; i < annotations.length; ++i) {
        if (!layers[annotations[i].anntype]) {
          layers[annotations[i].anntype] = [];
        }

        layers[annotations[i].anntype].push(annotations[i]);
      }

      const outlineColors:any = [
        {"red": [1, 0, 0]},
        {"blue": [0, 0.5, 1]},
        {"green": [0, 0.9, 0]},
        {"teal": [0, 1, 1]},
        {"orange": [1, 0.7, 0]},
        {"purple": [1, 0, 1]},
        {"yellow": [1, 1, 0]}
      ];

      let layersToDelete:any = [];
      this.layerManager.managedLayers.forEach(layer => {
        if (layer.layer instanceof AnnotationUserLayer && layer.name.indexOf("contours") != -1) {
          layersToDelete.push(layer.name);
        }
      });

      let colorIndex = 0;
      for (let cellType in layers) {
        const colorName = Object.keys(outlineColors[colorIndex])[0];
        const color = outlineColors[colorIndex][colorName];
        let layerBaseName = `contours-${cellType}`;
        let layerName = `${layerBaseName} (${colorName})`;

        let existingLayer = null;
        for (let i = 0; i < this.layerManager.managedLayers.length; ++i) {
          let layer = this.layerManager.managedLayers[i];
          if (layer.layer instanceof AnnotationUserLayer && layer.name.indexOf(layerBaseName) != -1) {
            existingLayer = layer;
            break;
          }
        };

        if (existingLayer) {
          layerName = existingLayer.name;
          this.layerManager.removeManagedLayer(existingLayer);
          
          let layerNameIndex = layersToDelete.indexOf(layerName);
          if (layerNameIndex != -1) {
            layersToDelete.splice(layerNameIndex, 1);
          }
        }

        try {
          const layer = new ManagedUserLayerWithSpecification(layerName, {}, this.layerSpecification);
          this.layerSpecification.initializeLayerFromSpec(layer, {type: "annotation", annotations: layers[cellType], anntype: cellType});

          const annotationLayer = layer.layer;
          if (annotationLayer instanceof AnnotationUserLayer) {
            annotationLayer.annotationColor.value[0] = color[0];
            annotationLayer.annotationColor.value[1] = color[1];
            annotationLayer.annotationColor.value[2] = color[2];
            annotationLayer.annotationColor.changed.dispatch();
  
            annotationLayer.localAnnotations.changed.add(() => {
              this.saveAnnotationLayerData(annotationLayer.sourceUrl!);
            });
  
            annotationLayer.sourceUrl = jsonUrl;
            annotationLayer.annotationType = cellType;
          }
  
          layer.sourceUrl = jsonUrl;
          this.layerSpecification.add(layer);
  
          colorIndex = (colorIndex + 1) % outlineColors.length;
        }
        catch {
          // TODO Refine this to be a modal popup.
          alert("Warning: contour data retrieved from the server is malformed; further actions taken may not be saved properly. Please contact the system administrator.");
        }
      }

      layersToDelete.forEach((layerName: string) => {
        let existingLayer:any = this.layerManager.getLayerByName(layerName);
        //this.layerManager.removeManagedLayer(existingLayer!);

        if (existingLayer && existingLayer.layer instanceof AnnotationUserLayer) {
          existingLayer.layer.localAnnotations.clear();
          existingLayer.sourceUrl = jsonUrl;
          existingLayer.layer.sourceUrl = jsonUrl;
        }
      });
    }, this.abortControllerContour);
  }

  private saveAnnotationLayerData(layerSource:string) {
    if (this.discardStateSaveRequests) {
      return;
    }

    if (this.loadingAxonCount || this.loadingCentroidCount || this.loadingContourCount) {
      return;
    }

    let isAnnotationInProgress = false;
    this.layerManager.managedLayers.forEach(layer => {
      if (layer.layer instanceof AnnotationUserLayer && layer.layer.tool.value instanceof TwoStepAnnotationTool && !layer.layer.tool.value.isLastUpdate) {
        isAnnotationInProgress = true;
      }
    });
    if (isAnnotationInProgress && !this.mouseState.isCompletingSelection) {
      return;
    }

    let layerData = [];

    // Re-combine the data for the layer.
    let managedLayers:any = this.layerManager.managedLayers;
    for (let i = 0; i < managedLayers.length; ++i) {
      if (managedLayers[i].layer instanceof AnnotationUserLayer && managedLayers[i].layer.sourceUrl == layerSource) {
        layerData.push(...managedLayers[i].layer.localAnnotations.toJSON());
      }
    }

    // When serializing TypedArray objects (e.g. coordinates from geometry buffers), a replacer function is applied to eliminate the keyed dictionary representation.
    fetch(layerSource, {
      method: "PUT",
      body: JSON.stringify(layerData, (_, v) => v instanceof Object.getPrototypeOf(Float32Array) ? Array.from(v) : v)
    });
  }

  private getAnnotationLayerData(layerSource:string, callback:Function, abortController:AbortController) {
    fetch(layerSource, {signal: abortController.signal})
      .then(response => response.json())
      .then(data => callback(data))
      .catch(() => callback([]));
  }
}
