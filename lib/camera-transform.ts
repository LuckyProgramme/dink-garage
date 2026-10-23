export const CAMERA_ROTATIONS = [0, 90, 180, 270] as const;

export type CameraRotation = (typeof CAMERA_ROTATIONS)[number];

export type CameraTransform = {
  video_rotation: CameraRotation;
  video_flip_horizontal: boolean;
  video_flip_vertical: boolean;
};

export const DEFAULT_CAMERA_TRANSFORM: CameraTransform = {
  video_rotation: 0,
  video_flip_horizontal: false,
  video_flip_vertical: false,
};

export function validCameraTransform(input: Record<string, unknown>) {
  const rotation = Number(input.video_rotation ?? 0);
  return (
    CAMERA_ROTATIONS.includes(rotation as CameraRotation) &&
    (input.video_flip_horizontal === undefined ||
      typeof input.video_flip_horizontal === "boolean") &&
    (input.video_flip_vertical === undefined ||
      typeof input.video_flip_vertical === "boolean")
  );
}

export function cameraTransform(
  input: Partial<CameraTransform> | null | undefined,
): CameraTransform {
  const rotation = Number(input?.video_rotation ?? 0);
  return {
    video_rotation: CAMERA_ROTATIONS.includes(rotation as CameraRotation)
      ? (rotation as CameraRotation)
      : 0,
    video_flip_horizontal: input?.video_flip_horizontal === true,
    video_flip_vertical: input?.video_flip_vertical === true,
  };
}

export function hasCameraTransform(input: Partial<CameraTransform>) {
  const transform = cameraTransform(input);
  return (
    transform.video_rotation !== 0 ||
    transform.video_flip_horizontal ||
    transform.video_flip_vertical
  );
}
