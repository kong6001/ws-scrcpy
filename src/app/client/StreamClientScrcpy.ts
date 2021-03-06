import { BaseClient } from './BaseClient';
import { ScrcpyStreamParams } from '../../common/ScrcpyStreamParams';
import { DroidMoreBox } from '../toolbox/DroidMoreBox';
import { DroidToolBox } from '../toolbox/DroidToolBox';
import VideoSettings from '../VideoSettings';
import Size from '../Size';
import { ControlMessage } from '../controlMessage/ControlMessage';
import { StreamReceiver } from './StreamReceiver';
import { CommandControlMessage } from '../controlMessage/CommandControlMessage';
import TouchHandler from '../TouchHandler';
import Util from '../Util';
import ScreenInfo from '../ScreenInfo';
import { TouchControlMessage } from '../controlMessage/TouchControlMessage';
import FilePushHandler from '../FilePushHandler';
import DragAndPushLogger from '../DragAndPushLogger';
import { KeyEventListener, KeyInputHandler } from '../KeyInputHandler';
import { KeyCodeControlMessage } from '../controlMessage/KeyCodeControlMessage';
import { BasePlayer, PlayerClass } from '../player/BasePlayer';
import DroidDeviceDescriptor from '../../common/DroidDeviceDescriptor';
import { ConfigureScrcpy, ConfigureScrcpyOptions } from './ConfigureScrcpy';
import { DeviceTrackerDroid } from './DeviceTrackerDroid';
import { DeviceTrackerCommand } from '../../common/DeviceTrackerCommand';
import { html } from '../ui/HtmlTag';

const ATTRIBUTE_UDID = 'data-udid';
const ATTRIBUTE_COMMAND = 'data-command';

export class StreamClientScrcpy extends BaseClient<never> implements KeyEventListener {
    public static ACTION: ScrcpyStreamParams['action'] = 'stream';
    private static players: Map<string, PlayerClass> = new Map<string, PlayerClass>();
    private static configureDialog?: ConfigureScrcpy;
    private hasTouchListeners = false;

    private controlButtons?: HTMLElement;
    private deviceName = '';
    private clientId = -1;
    private clientsCount = -1;
    private requestedVideoSettings?: VideoSettings;

    public static registerPlayer(playerClass: PlayerClass): void {
        if (playerClass.isSupported()) {
            this.players.set(playerClass.playerFullName, playerClass);
        }
    }

    public static getPlayers(): PlayerClass[] {
        return Array.from(this.players.values());
    }

    public static createPlayer(udid: string, playerName: string): BasePlayer | undefined {
        let playerClass: PlayerClass | undefined;
        for (const value of StreamClientScrcpy.players.values()) {
            if (value.playerFullName === playerName || value.playerCodeName === playerName) {
                playerClass = value;
            }
        }
        if (!playerClass) {
            return;
        }
        return new playerClass(udid);
    }

    public static createFromParam(params: ScrcpyStreamParams): StreamClientScrcpy {
        const streamReceiver = new StreamReceiver(params.ip, params.port, params.query);
        let player = params.player;
        if (typeof player !== 'string') {
            // TODO: remove deprecated
            player = params.decoder as string;
        }
        const client = new StreamClientScrcpy(streamReceiver);
        client.startStream(params.udid, player);
        client.setTitle(`${params.udid} stream`);
        return client;
    }

    public static createWithReceiver(
        streamReceiver: StreamReceiver,
        params: { udid: string; playerName: BasePlayer; fitIntoScreen?: boolean },
    ): StreamClientScrcpy {
        const client = new StreamClientScrcpy(streamReceiver);
        client.startStream(params.udid, params.playerName, params.fitIntoScreen);
        return client;
    }

    protected constructor(private readonly streamReceiver: StreamReceiver) {
        super();

        this.setBodyClass('stream');
    }

    public startStream(udid: string, playerName: string | BasePlayer, fitIntoScreen?: boolean): void {
        if (!udid) {
            return;
        }
        let player: BasePlayer;
        if (typeof playerName === 'string') {
            const p = StreamClientScrcpy.createPlayer(udid, playerName);
            if (!p) {
                throw Error(`Unsupported player: "${playerName}"`);
            }
            player = p;
        } else {
            player = playerName;
        }
        this.setTouchListeners(player);

        const deviceView = document.createElement('div');
        deviceView.className = 'device-view';
        const stop = (ev?: string | Event) => {
            if (ev && ev instanceof Event && ev.type === 'error') {
                console.error(ev);
            }
            let parent;
            parent = deviceView.parentElement;
            if (parent) {
                parent.removeChild(deviceView);
            }
            parent = moreBox.parentElement;
            if (parent) {
                parent.removeChild(moreBox);
            }
            this.streamReceiver.stop();
            player.stop();
        };

        const droidMoreBox = new DroidMoreBox(udid, player, this);
        const moreBox = droidMoreBox.getHolderElement();
        droidMoreBox.setOnStop(stop);
        const droidToolBox = DroidToolBox.createToolBox(udid, player, this, moreBox);
        this.controlButtons = droidToolBox.getHolderElement();
        deviceView.appendChild(this.controlButtons);
        const video = document.createElement('div');
        video.className = 'video';
        deviceView.appendChild(video);
        deviceView.appendChild(moreBox);
        player.setParent(video);
        player.pause();

        document.body.appendChild(deviceView);
        const current = player.getVideoSettings();
        if (typeof fitIntoScreen !== 'boolean') {
            fitIntoScreen = player.getPreferredVideoSetting().equals(current);
        }
        if (fitIntoScreen) {
            const bounds = this.getMaxSize();
            const { bitrate, maxFps, iFrameInterval, lockedVideoOrientation, sendFrameMeta } = current;
            const newVideoSettings = new VideoSettings({
                bounds,
                bitrate,
                maxFps,
                iFrameInterval,
                lockedVideoOrientation,
                sendFrameMeta,
            });
            player.setVideoSettings(newVideoSettings, false);
        }
        const element = player.getTouchableElement();
        const handler = new FilePushHandler(element, this.streamReceiver);
        const logger = new DragAndPushLogger(element);
        handler.addEventListener(logger);

        const streamReceiver = this.streamReceiver;
        streamReceiver.on('deviceMessage', (message) => {
            droidMoreBox.OnDeviceMessage(message);
        });
        streamReceiver.on('video', (data) => {
            const STATE = BasePlayer.STATE;
            if (player.getState() === STATE.PAUSED) {
                player.play();
            }
            if (player.getState() === STATE.PLAYING) {
                player.pushFrame(new Uint8Array(data));
            }
        });
        streamReceiver.on('clientsStats', (stats) => {
            this.deviceName = stats.deviceName;
            this.clientId = stats.clientId;
            this.clientsCount = stats.clientsCount;
        });
        streamReceiver.on('videoParameters', ({ screenInfo, videoSettings }) => {
            let min = VideoSettings.copy(videoSettings);
            let playing = false;
            const STATE = BasePlayer.STATE;
            if (player.getState() === STATE.PAUSED) {
                player.play();
            }
            if (player.getState() === STATE.PLAYING) {
                playing = true;
            }
            const oldInfo = player.getScreenInfo();
            if (!screenInfo.equals(oldInfo)) {
                player.setScreenInfo(screenInfo);
            }

            const oldSettings = player.getVideoSettings();
            if (!videoSettings.equals(oldSettings)) {
                player.setVideoSettings(videoSettings, videoSettings.equals(this.requestedVideoSettings));
            }
            if (!oldInfo) {
                const bounds = oldSettings.bounds;
                const videoSize: Size = screenInfo.videoSize;
                const onlyOneClient = this.clientsCount === 0;
                const smallerThenCurrent =
                    bounds && (bounds.width < videoSize.width || bounds.height < videoSize.height);
                if (onlyOneClient || smallerThenCurrent) {
                    min = oldSettings;
                }
            }
            if (!min.equals(videoSettings) || !playing) {
                this.sendEvent(CommandControlMessage.createSetVideoSettingsCommand(min));
            }
        });
        console.log(player.getName(), udid);
    }

    public sendEvent(e: ControlMessage): void {
        this.streamReceiver.sendEvent(e);
    }

    public getDeviceName(): string {
        return this.deviceName;
    }

    public setHandleKeyboardEvents(enabled: boolean): void {
        if (enabled) {
            KeyInputHandler.addEventListener(this);
        } else {
            KeyInputHandler.removeEventListener(this);
        }
    }

    public onKeyEvent(event: KeyCodeControlMessage): void {
        this.sendEvent(event);
    }

    public sendNewVideoSetting(videoSettings: VideoSettings): void {
        this.requestedVideoSettings = videoSettings;
        this.sendEvent(CommandControlMessage.createSetVideoSettingsCommand(videoSettings));
    }

    public getClientId(): number {
        return this.clientId;
    }

    public getClientsCount(): number {
        return this.clientsCount;
    }

    public getMaxSize(): Size | undefined {
        if (!this.controlButtons) {
            return;
        }
        const body = document.body;
        const width = (body.clientWidth - this.controlButtons.clientWidth) & ~15;
        const height = body.clientHeight & ~15;
        return new Size(width, height);
    }

    private setTouchListeners(player: BasePlayer): void {
        if (!this.hasTouchListeners) {
            TouchHandler.init();
            let down = 0;
            const supportsPassive = Util.supportsPassive();
            const onMouseEvent = (e: MouseEvent | TouchEvent) => {
                const tag = player.getTouchableElement();
                if (e.target === tag) {
                    const screenInfo: ScreenInfo = player.getScreenInfo() as ScreenInfo;
                    if (!screenInfo) {
                        return;
                    }
                    let events: TouchControlMessage[] | null = null;
                    let condition = true;
                    if (e instanceof MouseEvent) {
                        condition = down > 0;
                        events = TouchHandler.buildTouchEvent(e, screenInfo);
                    } else if (e instanceof TouchEvent) {
                        events = TouchHandler.formatTouchEvent(e, screenInfo, tag);
                    }
                    if (events && events.length && condition) {
                        events.forEach((event) => {
                            this.sendEvent(event);
                        });
                    }
                    if (e.cancelable) {
                        e.preventDefault();
                    }
                    e.stopPropagation();
                }
            };

            const options = supportsPassive ? { passive: false } : false;
            document.body.addEventListener(
                'touchstart',
                (e: TouchEvent): void => {
                    onMouseEvent(e);
                },
                options,
            );
            document.body.addEventListener(
                'touchend',
                (e: TouchEvent): void => {
                    onMouseEvent(e);
                },
                options,
            );
            document.body.addEventListener(
                'touchmove',
                (e: TouchEvent): void => {
                    onMouseEvent(e);
                },
                options,
            );
            document.body.addEventListener(
                'touchcancel',
                (e: TouchEvent): void => {
                    onMouseEvent(e);
                },
                options,
            );
            document.body.addEventListener('mousedown', (e: MouseEvent): void => {
                down++;
                onMouseEvent(e);
            });
            document.body.addEventListener('mouseup', (e: MouseEvent): void => {
                onMouseEvent(e);
                down--;
            });
            document.body.addEventListener('mousemove', (e: MouseEvent): void => {
                onMouseEvent(e);
            });
            this.hasTouchListeners = true;
        }
    }

    public static createEntryForDeviceList(
        descriptor: DroidDeviceDescriptor,
        blockClass: string,
    ): HTMLElement | DocumentFragment | undefined {
        const hasPid = descriptor.pid !== -1;
        if (hasPid) {
            const configureButtonId = `configure_${Util.escapeUdid(descriptor.udid)}`;
            const e = html`<div class="stream ${blockClass}">
                <button
                    ${ATTRIBUTE_UDID}="${descriptor.udid}"
                    ${ATTRIBUTE_COMMAND}="${DeviceTrackerCommand.CONFIGURE_STREAM}"
                    id="${configureButtonId}"
                    class="active action-button"
                >
                    Configure stream
                </button>
            </div>`;
            const a = e.content.getElementById(configureButtonId);
            a && (a.onclick = this.onConfigureStreamClick);
            return e.content;
        }
        return;
    }

    private static onConfigureStreamClick = (e: MouseEvent): void => {
        const button = e.currentTarget as HTMLAnchorElement;
        const udid = button.getAttribute(ATTRIBUTE_UDID);
        if (!udid) {
            return;
        }
        const tracker = DeviceTrackerDroid.getInstance();
        const descriptor = tracker.getDescriptorByUdid(udid);
        if (!descriptor) {
            return;
        }
        e.preventDefault();
        const elements = document.getElementsByName(
            `${DeviceTrackerDroid.AttributePrefixInterfaceSelectFor}${Util.escapeUdid(udid)}`,
        );
        if (!elements || !elements.length) {
            return;
        }
        const select = elements[0] as HTMLSelectElement;
        const optionElement = select.options[select.selectedIndex];
        const port = optionElement.getAttribute('data-port');
        const name = optionElement.getAttribute('data-name');
        const ipv4 = optionElement.getAttribute('value');
        const query = optionElement.getAttribute('data-query') || undefined;
        if (!port || !ipv4 || !name) {
            return;
        }
        const options: ConfigureScrcpyOptions = {
            port,
            name,
            ipv4,
            query,
        };
        const dialog = new ConfigureScrcpy(descriptor, options);
        dialog.on('closed', StreamClientScrcpy.onConfigureDialogClosed);
        StreamClientScrcpy.configureDialog = dialog;
    };

    private static onConfigureDialogClosed = (success: boolean): void => {
        StreamClientScrcpy.configureDialog?.off('closed', StreamClientScrcpy.onConfigureDialogClosed);
        StreamClientScrcpy.configureDialog = undefined;
        if (success) {
            const tracker = DeviceTrackerDroid.getInstance();
            tracker?.destroy();
            return;
        }
    };
}
