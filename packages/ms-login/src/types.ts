export type SecretFieldType = "email" | "password" | "otp";

export interface LoginPage {
  goto(url: string): Promise<void>;
  visible(selector: string): Promise<boolean>;
  text(selector: string): Promise<string | null>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  location(): Promise<string>;
  saveStorage(path: string): Promise<void>;
}

export interface SecretInputRequest {
  id: string;
  label: string;
  type: SecretFieldType;
  prompt?: string;
}

export interface SecretConfirmRequest {
  id: string;
  prompt: string;
}

export interface StepClient {
  input(request: SecretInputRequest): Promise<string>;
  confirm(request: SecretConfirmRequest): Promise<void>;
}
