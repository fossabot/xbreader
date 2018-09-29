import m from "mithril";
import cdn from "../helpers/cdn";
import { Promise } from "core-js";

const HIGH_THRESHOLD = 5;
const LOW_THRESHOLD = 3;
const workerSupported = typeof(Worker) === "undefined" ? false : true;
// TODO if worker not supported don't make below objects

const f = () => {
    //const useFetch = typeof(fetch) !== "undefined" ? true : false;
    //const useFetch = false;
    let queued = [];
    const locate = (src) => queued.map((o) => o.src).indexOf(src);
    const isQueued = (src) => locate(src) !== -1;
    const deqeue = (src) => {
        const i = locate(src);
        if (i != -1)
            queued.splice(i, 1);
    };
    self.addEventListener("message", e => {
        const src = e.data.src;
        let xhr;
        switch (e.data.mode) {
        case "FETCH":
            if(isQueued(src)) // If already queued
                return; // Do nothing

                /*
                 * I'm not going to consider using fetch until
                 * https://developer.mozilla.org/en-US/docs/Web/API/AbortController/abort
                 * is more widely supported, because you have browser
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
            xhr.responseType = "blob";
            xhr.onloadend = () => {
                if(!isQueued(src)) // Stop because canceled
                    return;
                if(xhr.status && xhr.status < 400) {
                    const url = URL.createObjectURL(xhr.response);
                    self.postMessage({ src, url });
                } else {
                    // todo new Error();
                    const error = `Failed to load image ${src}, status ${xhr.status}`;
                    self.postMessage({ src, error });
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
const worker = new Worker(URL.createObjectURL(new Blob([`(${f})()`])));

export default class LazyLoader {
    constructor(imageData, imageIndex) {
        this.original = cdn.image(imageData, imageIndex);
        this.mime = imageData.mime;
        this.index = imageIndex;
        this.loaded = false;
        this.blob = null;

        this.canvas = document.createElement("canvas");
        this.canvas.height = imageData.height;
        this.canvas.width = imageData.width;
    }

    provoke(imageItem, currentIndex) {
        this.image = imageItem.dom;
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

        // If still loading image but moved away from it in the meantime
        } else if (this.preloader && !this.loaded) {
            if(workerSupported)
                worker.postMessage({src: this.original, mode: "CANCEL"});
            else
                this.preloader.src = ""; // Cancels currently loading image
            this.preloader = null; // Reset the preloader
        }
    }

    toBlob(callback, type, quality) {
        if(this.loaded)
            return;
        if(HTMLCanvasElement.prototype.toBlob) {
            this.canvas.toBlob((blob) => {
                this.blob = URL.createObjectURL(blob);
                if(!this.loaded)
                    this.image.src = this.blob;
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

    draw(element) {
        clearTimeout(this.drawT);
        this.drawT = setTimeout(() => {
            const cd = this.canvas;
            if (!cd)
                return;
            const ctx = cd.getContext("2d");
            ctx.clearRect(0, 0, cd.width, cd.height);
            if (element instanceof HTMLImageElement) {
                ctx.drawImage(element, 0, 0, cd.width, cd.height);
            } else {
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillStyle = "grey";

                ctx.font = "normal bold 150px sans-serif";
                ctx.fillText(element, cd.width / 2, cd.height / 2);

                ctx.font = "normal 20px sans-serif";
                const fn = this.original.split("/");
                const fnnq = fn[fn.length - 1].split("?")[0];
                const infoString = `${__NAME__} ${__VERSION__} → ${fnnq}`;
                ctx.fillText(infoString, cd.width / 2, cd.height - 20);
            }
            this.drawAsSoon();
        });
    }

    drawAsSoon() {
        if(this.image) {
            if(this.loaded) {
                if(!workerSupported)
                    this.image.src = this.preloader.src;
                if(this.blob)
                    URL.revokeObjectURL(this.blob);
                return;
            } else {
                if(this.blob)
                    return;
                this.blob = "empty";
                this.toBlob(/*this.mime*/);
            }
        }
        window.requestAnimationFrame(this.drawAsSoon.bind(this));
    }

    lazyWorker(src) {
        return new Promise((resolve, reject) => {
            function handler(e) {
                if (e.data.src === src) {
                    worker.removeEventListener("message", handler);
                    if (e.data.error) {
                        reject(e.data.error);
                    }
                    resolve(e.data.url);
                }
            }
            worker.addEventListener("message", handler);
            worker.postMessage({src, mode: "FETCH"});
        });
    }

    prepare() {
        if (this.preloader)
            return;
        if (!this.loaded) {
            this.draw(__("Loading..."));
        }
        if (!workerSupported) {
            this.preloader = document.createElement("img");
            this.preloader.onload = () => {
                if (!this.preloader)
                    return;
                this.loaded = true;
                this.drawAsSoon();
            };
            this.preloader.onerror = () => {
                setTimeout(() => {
                    if(!this.loaded && this.preloader) {
                        console.error("Error loading page " + this.original);
                        this.blob = null;
                        this.draw(__("Error!"));
                    }
                }, 1000);
            };
            this.preloader.src = this.original;
        } else {
            this.preloader = {
                src: null
            };
            this.lazyWorker(this.original).then(img => {
                if (!this.preloader)
                    return;
                this.loaded = true;
                this.image.src = img;
            }).catch(err => {
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

    get placeholderReady() {
        return this.placeholder.complete || this.placeholder.naturalWidth > 0;
    }
}