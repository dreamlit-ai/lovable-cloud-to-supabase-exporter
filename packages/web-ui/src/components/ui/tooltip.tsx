"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function useHoverCapable() {
  const [hoverCapable, setHoverCapable] = React.useState(true);

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;

    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => setHoverCapable(mq.matches);
    update();

    const add =
      mq.addEventListener ||
      (
        mq as MediaQueryList & {
          addListener?: (type: string, listener: () => void) => void;
        }
      ).addListener;
    const remove =
      mq.removeEventListener ||
      (
        mq as MediaQueryList & {
          removeListener?: (type: string, listener: () => void) => void;
        }
      ).removeListener;

    try {
      add.call(mq, "change", update);
    } catch {
      // no-op
    }

    return () => {
      try {
        remove.call(mq, "change", update);
      } catch {
        // no-op
      }
    };
  }, []);

  return hoverCapable;
}

const TooltipProvider = TooltipPrimitive.Provider;

type TooltipModeContextValue = { usePopover: boolean };

const TooltipModeContext = React.createContext<TooltipModeContextValue | null>(null);

function useTooltipMode() {
  const ctx = React.useContext(TooltipModeContext);
  return ctx ?? { usePopover: false };
}

const Tooltip = ({
  delayDuration = 0,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root> &
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Root>) => {
  const hoverCapable = useHoverCapable();
  const usePopover = !hoverCapable;
  const value = React.useMemo(() => ({ usePopover }), [usePopover]);

  return (
    <TooltipModeContext.Provider value={value}>
      {usePopover ? (
        <PopoverPrimitive.Root {...props} />
      ) : (
        <TooltipPrimitive.Provider delayDuration={delayDuration}>
          <TooltipPrimitive.Root {...props} />
        </TooltipPrimitive.Provider>
      )}
    </TooltipModeContext.Provider>
  );
};
Tooltip.displayName = "ResponsiveTooltip";

const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(({ asChild, children, ...props }, ref) => {
  const { usePopover } = useTooltipMode();
  const Comp = usePopover
    ? (PopoverPrimitive.Trigger as React.ComponentType<
        React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
      >)
    : TooltipPrimitive.Trigger;

  return asChild ? (
    <Comp
      ref={ref as React.Ref<React.ElementRef<typeof TooltipPrimitive.Trigger>>}
      asChild
      {...props}
    >
      {children}
    </Comp>
  ) : (
    <Comp ref={ref as React.Ref<React.ElementRef<typeof TooltipPrimitive.Trigger>>} {...props}>
      {children}
    </Comp>
  );
});
TooltipTrigger.displayName = "ResponsiveTooltipTrigger";

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => {
  const { usePopover } = useTooltipMode();
  const common = {
    className: cn(
      "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 overflow-hidden rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-900 shadow-md",
      "max-w-[min(92vw,22rem)]",
      className,
    ),
    style: { zIndex: 9999, ...props.style },
  };

  if (!usePopover) {
    return (
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content ref={ref} sideOffset={sideOffset} {...props} {...common} />
      </TooltipPrimitive.Portal>
    );
  }

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref as React.Ref<React.ElementRef<typeof PopoverPrimitive.Content>>}
        sideOffset={sideOffset}
        {...props}
        {...common}
      />
    </PopoverPrimitive.Portal>
  );
});
TooltipContent.displayName = "ResponsiveTooltipContent";

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
