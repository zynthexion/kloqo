export function ConvenienceFeeDisplay() {
    return (
        <div className="flex items-center gap-3">
            <span className="font-bold text-lg text-muted-foreground ml-1 font-mono">&#8377;</span>
            <div className="flex items-center gap-2">
                <span className="text-muted-foreground line-through">10 Convenience Fee</span>
                <span className="text-xs font-semibold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
                    Waived 🎉
                </span>
            </div>
        </div>
    );
}
