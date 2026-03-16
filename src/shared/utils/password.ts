import { compare, hash } from "bcryptjs";

const passwordSaltRounds = 10;

export const hashPassword = async (value: string): Promise<string> => {
  return hash(value, passwordSaltRounds);
};

export const comparePassword = async (value: string, hashedValue: string): Promise<boolean> => {
  return compare(value, hashedValue);
};
