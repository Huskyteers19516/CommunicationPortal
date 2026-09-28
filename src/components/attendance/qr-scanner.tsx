"use client";

import { CameraOff, KeyRound, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { attendanceScanPath } from "@/lib/attendance";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";

/** Frames decoded per second (enough to feel instant, light on phone batteries). */
const SCANS_PER_SECOND = 5;
/** Frames are shrunk to at most this width before decoding. */
const DECODE_WIDTH = 640;

const MESSAGES = {
  insecure: "The camera only works on a secure (https) page. Type the code on the screen instead.",
  unsupported: "This browser can't use the camera here. Type the code on the screen instead, or scan with your phone's camera app.",
  denied: "Camera access is blocked. Allow the camera for this site in your browser settings, or type the code instead.",
  noCamera: "No camera found on this device. Type the code on the screen instead.",
  busy: "The camera is busy in another app. Close that app and try again, or type the code instead.",
  other: "Couldn't start the camera. Type the code on the screen instead.",
};

/** A friendly message for getUserMedia's error. */
export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return MESSAGES.denied;
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return MESSAGES.noCamera;
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return MESSAGES.busy;
  return MESSAGES.other;
}

type ScanState = { kind: "starting" } | { kind: "scanning"; hint?: string } | { kind: "found" } | { kind: "error"; message: string };

/**
 * The in-app QR scanner: the back camera in a small window, decoded with jsQR about 5 times a second. Only our
 * own /attendance/scan/… links are followed (other QR codes are ignored). The camera stops as soon as a code is
 * found, when "Stop camera" is pressed, and when this goes away.
 */
export function QrScanner({ origins, onClose, onUseCode }: { origins: string[]; onClose: () => void; onUseCode: () => void }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<ScanState>({ kind: "starting" });
  const originsKey = origins.join(" ");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    // Our configured address, plus this page's own (a preview deployment, or a LAN address while testing).
    const allowed = [...originsKey.split(" "), window.location.origin];

    function stop() {
      stopped = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    }

    async function start() {
      if (typeof window === "undefined" || !window.isSecureContext) return setState({ kind: "error", message: MESSAGES.insecure });
      if (!navigator.mediaDevices?.getUserMedia) return setState({ kind: "error", message: MESSAGES.unsupported });
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch (e) {
        if (!stopped) setState({ kind: "error", message: cameraErrorMessage(e) });
        return;
      }
      if (stopped) return stop();
      const video = videoRef.current;
      if (!video) return stop();
      video.srcObject = stream;
      await video.play().catch(() => {});
      let jsQR: typeof import("jsqr").default;
      try {
        jsQR = (await import("jsqr")).default;
      } catch {
        if (!stopped) setState({ kind: "error", message: MESSAGES.other });
        return stop();
      }
      if (stopped) return;
      setState({ kind: "scanning" });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      let ignoredUntil = 0;
      timer = setInterval(() => {
        if (stopped || !context || video.readyState < video.HAVE_CURRENT_DATA || !video.videoWidth) return;
        const scale = Math.min(1, DECODE_WIDTH / video.videoWidth);
        const width = Math.round(video.videoWidth * scale);
        const height = Math.round(video.videoHeight * scale);
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        context.drawImage(video, 0, 0, width, height);
        const found = jsQR(context.getImageData(0, 0, width, height).data, width, height, { inversionAttempts: "dontInvert" });
        if (!found?.data) return;
        const path = attendanceScanPath(found.data, allowed);
        if (!path) {
          if (Date.now() > ignoredUntil) setState({ kind: "scanning", hint: "That QR code isn't an attendance code. Point at the one on the screen." });
          ignoredUntil = Date.now() + 3000;
          return;
        }
        stop();
        setState({ kind: "found" });
        router.push(path);
      }, 1000 / SCANS_PER_SECOND);
    }

    void start();
    return stop;
  }, [originsKey, router]);

  const failed = state.kind === "error";

  return (
    <div className="space-y-3">
      {failed ? (
        <Alert tone="warning" role="alert" title="Can't use the camera">
          {state.message}
        </Alert>
      ) : (
        <div className="relative mx-auto aspect-square w-full max-w-sm overflow-hidden rounded-xl bg-ink-900">
          <video ref={videoRef} playsInline muted autoPlay className="size-full object-cover" aria-label="Camera view for scanning the QR code" />
          <div className="pointer-events-none absolute inset-8 rounded-2xl border-4 border-white/80" aria-hidden />
          {state.kind === "starting" && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-white">
              <LoaderCircle className="mr-2 size-4 animate-spin" aria-hidden />
              Starting the camera…
            </div>
          )}
        </div>
      )}
      <p role="status" className="text-center text-sm text-ink-600">
        {state.kind === "scanning" && (state.hint ?? "Point the camera at the QR code on the screen.")}
        {state.kind === "found" && "Got it! Checking you in…"}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {failed && (
          <Button onClick={onUseCode}>
            <KeyRound className="size-4" aria-hidden />
            Type the code instead
          </Button>
        )}
        <Button variant="secondary" onClick={onClose}>
          <CameraOff className="size-4" aria-hidden />
          {failed ? "Close" : "Stop camera"}
        </Button>
      </div>
    </div>
  );
}
