export default async function asyncDelay(seconds: number) {
    return await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}