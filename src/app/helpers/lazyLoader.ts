import cdn from "./cdn";
import sML from "./sMLstub";
import Link from "xbreader/models/Link";
import { CVnodeDOM } from "mithril";

const HIGH_THRESHOLD = 5;
const LOW_THRESHOLD = 3;

interface QueueElement {
    xhr: XMLHttpRequest;
    src: string;

}
const workerSupported = typeof(Worker) === "undefined" ? false : true;
let f, worker: Worker;
if(workerSupported) {
    f = () => {
        const ctx: Worker = self as any;
        //const useFetch = typeof(fetch) !== "undefined" ? true : false;
        //const useFetch = false;
        let queued: QueueElement[] = [];
        const locate = (src: string) => queued.map((o) => o.src).indexOf(src);
        const isQueued = (src: string) => locate(src) !== -1;
        const deqeue = (src: string) => {
            const i = locate(src);
            if (i != -1)
                queued.splice(i, 1);
        };
        self.addEventListener("message", e => {
            const src = e.data.src;
            let xhr: XMLHttpRequest;
            switch (e.data.mode) {
            case "FETCH":
                if(isQueued(src)) // If already queued
                    return; // Do nothing
    
                    /*
                     * I'm not going to consider using fetch until
                     * https://developer.mozilla.org/en-US/docs/Web/API/AbortController/abort
                     * is more widely supported, because you have browsers
                     * 1. With fetch and AbortController support (bleeding edge)
                     * 2. With fetch, but not AbortController
                     * 3. With neither, in which case we implement XHR instead of using fetch
                     * So why not just use XHR in all of them?
                     * 
                    if(useFetch) { // If fetch is supported by the browser
                        queued.push({src, xhr});
                        fetch(src, { mode: 'cors' })
                            .then(response => {
                                if(!isQueued(src)) // Stop because canceled
                                    return null;
                                return response.blob();
                            })
                            .then(blob => {
                                if(!isQueued(src) || !blob) // Stop because canceled
                                    return;
                                const url = URL.createObjectURL(blob);
                                self.postMessage({ src, url });
                                deqeue(src);
                            }).catch(err => {
                                self.postMessage({ src, error: new String(err) });
                                deqeue(src);
                            });
                        return;
                    }
                    // Fall back to using XHR when fetch is not supported
                    */
                xhr = new XMLHttpRequest();
                queued.push({src, xhr});
                xhr.open("GET", src, true);
                // xhr.setRequestHeader("Content-Type", "image/*"); would preflight request, which is unecessary for pub resources
                if(e.data.modernImage)
                    xhr.setRequestHeader("Accept", "image/webp,image/*,*/*;q=0.8"); // Support WebP where available
                else
                    xhr.setRequestHeader("Accept", e.data.type + ",image/*,*/*;q=0.8");
                xhr.responseType = "blob";
                xhr.onloadend = () => {
                    if(!isQueued(src)) // Stop because canceled
                        return;
                    if(xhr.status && xhr.status < 400) {
                        if(e.data.bitmap && (typeof(ImageBitmap) !== "undefined")) { // ImageBitmap supported
                            createImageBitmap(xhr.response).then((bitmap) => {
                                ctx.postMessage({ src, bitmap }, [bitmap]);
                            });
                        } else {
                            const url = URL.createObjectURL(xhr.response);
                            ctx.postMessage({ src, url });
                        }
                    } else {
                        const error = `Failed to load item ${src}, status ${xhr.status}`;
                        ctx.postMessage({ src, error });
                    }
                    deqeue(src);
                };
                xhr.send(null);
                break;
            case "CANCEL": { // Cancel an item's loading
                const item = queued[locate(src)];
                if(!item)
                    return;
                if(item.xhr)
                    item.xhr.abort();
                deqeue(src);
                break;
            }
            }
            
                  
        });
    };
    worker = new Worker(URL.createObjectURL(new Blob([`(${f})()`])));
}

// https://stackoverflow.com/a/27232658/2052267
const WebPChecker = () => {
    const elem = document.createElement("canvas");
    if (elem.getContext && elem.getContext("2d"))
        // was able or not to get WebP representation
        return elem.toDataURL("image/webp").indexOf("data:image/webp") == 0;
    else
        // very old browser like IE 8, canvas not supported
        return false;
};
const canWebP = WebPChecker();

export default class LazyLoader {
    original: string;
    data: Link;
    index: number;
    loaded: boolean;
    reloader: boolean;
    blob: string;
    drm: Function;
    canvas: HTMLCanvasElement;
    image: HTMLImageElement | HTMLCanvasElement;
    highTime: number;
    preloader: HTMLImageElement | Object;
    drawT: number;

    constructor(itemData: Link, imageIndex: number, drmCallback: Function) {
        this.original = cdn.image(itemData, imageIndex);
        this.data = itemData;
        this.index = imageIndex;
        this.loaded = false;
        this.reloader = false;
        this.blob = null;

        if(itemData.Properties && itemData.Properties.Encrypted) {
            this.drm = drmCallback;
        } else if(itemData.Height && itemData.Width) {
            this.canvas = document.createElement("canvas");
            this.canvas.height = itemData.Height;
            this.canvas.width = itemData.Width;
        }        
    }

    provoke(imageItem: CVnodeDOM<HTMLImageElement | HTMLCanvasElement>, currentIndex: number) {
        this.image = <any>imageItem.dom; // :(
        if(this.drm)
            this.canvas = <HTMLCanvasElement>this.image; // C
        const diff = Math.abs(this.index - currentIndex); // Distance of this page from current page
        clearTimeout(this.highTime);

        // If index of this page close enough to current page index, load now
        if (diff <= LOW_THRESHOLD)
            this.prepare(); // Start loading the image

        // If index of page near current page, load after predicted end of transition
        else if(diff <= HIGH_THRESHOLD) {
            this.highTime = setTimeout(() => {
                this.prepare();
            }, 1000);

        // If image is loaded on canvas, on mobile, and > HIGH_THRESHOLD away from the image
        // Especially needed on iOS where canvas memory is constrained
        } else if(this.drm && this.loaded && this.canvas && sML.Mobile) {
            const ctx = this.canvas.getContext("2d");
            if(!ctx) return;
            ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.canvas.height = this.canvas.width = 0;
            this.loaded = false;
            this.reloader = true;

        // If still loading image but moved away from it in the meantime
        } else if (this.preloader && !this.loaded) {
            if(workerSupported)
                worker.postMessage({src: this.original, mode: "CANCEL"});
            else
                (<HTMLImageElement>this.preloader).src = ""; // Cancels currently loading image
            this.preloader = null; // Reset the preloader
        }
    }

    toBlob(type?: string, quality?: number) {
        if(this.loaded)
            return;
        if(HTMLCanvasElement.prototype.toBlob) {
            this.canvas.toBlob((blob) => {
                this.blob = URL.createObjectURL(blob);
                if(!this.loaded)
                    (<HTMLImageElement>this.image).src = this.blob;
            });
        } else {
            let binStr = atob(this.canvas.toDataURL(type, quality).split(",")[1]),
                len = binStr.length,
                arr = new Uint8Array(len);

            for (var i = 0; i < len; i++)
                arr[i] = binStr.charCodeAt(i);

            this.blob = URL.createObjectURL(new Blob([arr], {
                type: type || "image/png"
            }));
        }
    }

    draw(element: HTMLElement | string) {
        cancelAnimationFrame(this.drawT);
        this.drawT = requestAnimationFrame(() => {
            const cd = this.canvas;
            if (!cd)
                return;
            const ctx = cd.getContext("2d");

            if(ctx) {
                ctx.clearRect(0, 0, cd.width, cd.height);
                if (element instanceof HTMLImageElement) {
                    ctx.drawImage(element, 0, 0, cd.width, cd.height);
                } else {
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillStyle = "grey";
    
                    ctx.font = "normal bold 150px sans-serif";
                    ctx.fillText(<string>element, cd.width / 2, cd.height / 2);
    
                    ctx.font = "normal 20px sans-serif";
                    const fn = this.original.split("/");
                    const fnnq = fn[fn.length - 1].split("?")[0];
                    const infoString = `${__NAME__} ${__VERSION__} → ${fnnq}`;
                    ctx.fillText(infoString, cd.width / 2, cd.height - 20);
                }
            } else {
                console.warn("No canvas context!");
            }
            this.drawAsSoon();
        });
    }

    drawAsSoon() {
        if(this.image) {
            if(this.loaded) {
                if(!workerSupported && !this.drm) // C
                    (<HTMLImageElement>this.image).src = (<HTMLImageElement>this.preloader).src;
                if(this.blob)
                    URL.revokeObjectURL(this.blob);
                return;
            } else {
                if(this.blob || this.drm) // C
                    return;
                this.blob = "empty";
                this.toBlob();
            }
        }
        requestAnimationFrame(this.drawAsSoon.bind(this));
    }

    lazyWorker(src: string) {
        return new Promise((resolve: Function, reject: Function) => {
            function handler(e: MessageEvent) {
                if (e.data.src === src) {
                    worker.removeEventListener("message", handler);
                    if (e.data.error) {
                        reject(e.data.error);
                    }
                    if(e.data.url)
                        resolve(e.data.url);
                    else if(e.data.bitmap)
                        resolve(e.data.bitmap);
                    else
                        reject("No data received from worker!");
                }
            }
            worker.addEventListener("message", handler);
            if(this.data.findFlag("isImage"))
                worker.postMessage({src, mode: "FETCH", modernImage: canWebP, bitmap: this.drm ? true : false});
            else
                worker.postMessage({src, mode: "FETCH", type: this.data.TypeLink});
        });
    }

    prepare() {
        if(this.reloader) {
            this.canvas.height = this.data.Height;
            this.canvas.width = this.data.Width;
            this.reloader = false;
        } else if(this.preloader)
            return;

        if (!this.loaded) {
            this.draw(__("Loading..."));
        }
        if (!workerSupported) {
            this.preloader = document.createElement("img");
            (<HTMLImageElement>this.preloader).onload = () => {
                if (!this.preloader)
                    return;
                if(this.drm)
                    this.drm(this, (<HTMLImageElement>this.preloader).src);
                else {
                    this.loaded = true;
                    requestAnimationFrame(() => this.drawAsSoon());
                }
            };
            (<HTMLImageElement>this.preloader).onerror = () => {
                setTimeout(() => {
                    if(!this.loaded && this.preloader) {
                        console.error("Error loading page " + this.original);
                        this.blob = null;
                        this.draw(__("Error!"));
                    }
                }, 1000);
            };
            (<HTMLImageElement>this.preloader).src = this.original;
        } else {
            this.preloader = {
                src: null
            };
            this.lazyWorker(this.original).then((img: any) => {
                if (!this.preloader)
                    return;
                if(this.drm)
                    this.drm(this, img);
                else {
                    this.loaded = true;
                    (<HTMLImageElement>this.image).src = img;
                }
                // this.blob = img;
            }).catch((err: Error) => {
                setTimeout(() => {
                    if(!this.loaded && this.preloader) {
                        console.error(`Error fetching page ${this.original}\n${err}`);
                        this.blob = null;
                        this.draw(__("Error!"));
                    }
                }, 1000);
            });
        }
    }

    get preloaded() {
        return this.loaded && this.preloader;
    }
}