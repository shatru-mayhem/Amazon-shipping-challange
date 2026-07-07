import { redirect } from "next/navigation";

// The employee workspace moved to /employee/dashboard in the Unified
// Intelligence redesign. Keep /employee working for older links and docs.
export default function EmployeeIndex() {
  redirect("/employee/dashboard");
}
